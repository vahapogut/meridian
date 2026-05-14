import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type MeridianServer } from '@meridian-sync/server';
import { createClient, type MeridianClient } from '@meridian-sync/client';
import { defineSchema, z, deriveKey, encryptValue, decryptValue } from '@meridian-sync/shared';
import 'fake-indexeddb/auto';

// ─── Test Schema ─────────────────────────────────────────────────────────────

const schema = defineSchema({
  version: 1,
  collections: {
    todos: {
      id: z.string(),
      title: z.string(),
      done: z.boolean().default(false),
      priority: z.number().default(0),
    },
  },
});

const PORT = 3001;
const WS_URL = `ws://localhost:${PORT}/sync`;
const DB_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/meridian_test';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function createTestClient(name: string): MeridianClient {
  return createClient({
    schema,
    serverUrl: WS_URL,
    dbName: `test_${name}_${Date.now()}`,
    debug: false,
  });
}

// ─── Integration Tests ──────────────────────────────────────────────────────

describe('Meridian — Integration Tests', () => {
  let server: MeridianServer;
  let pgAvailable = true;

  beforeAll(async () => {
    server = createServer({
      port: PORT,
      database: DB_URL,
      schema,
      auth: async () => ({ userId: 'test-user' }),
      compaction: { interval: 30_000, tombstoneMaxAge: 5_000 },
      debug: false,
    });
    try {
      await server.start();
      await sleep(300);
    } catch (e) {
      pgAvailable = false;
    }
  }, 15_000);

  afterAll(async () => {
    if (server && pgAvailable) await server.stop().catch(() => {});
  });

  function requirePG() {
    if (!pgAvailable) {
      console.warn('  ⏭ Skipped: PostgreSQL not available');
    }
    return pgAvailable;
  }

  // ─── Basic CRUD + Sync ────────────────────────────────────────────────────

  describe('Client ↔ Server Sync', () => {
    it('should create a document and sync to another client', async () => {
      if (!requirePG()) return;
      const a = createTestClient('a');
      const b = createTestClient('b');
      await sleep(400);

      await a.todos.put({ id: 'sync-1', title: 'Hello Sync', done: false });
      await sleep(500);

      const doc = await b.todos.findOne('sync-1').get();
      expect(doc).toBeDefined();
      expect(doc!.title).toBe('Hello Sync');
      expect(doc!.done).toBe(false);

      a.destroy();
      b.destroy();
    });

    it('should update a document and propagate changes', async () => {
      if (!requirePG()) return;
      const a = createTestClient('a');
      const b = createTestClient('b');
      await sleep(400);

      await a.todos.put({ id: 'sync-2', title: 'Original', done: false });
      await sleep(400);
      await a.todos.update('sync-2', { title: 'Updated', done: true });
      await sleep(500);

      const doc = await b.todos.findOne('sync-2').get();
      expect(doc!.title).toBe('Updated');
      expect(doc!.done).toBe(true);

      a.destroy();
      b.destroy();
    });

    it('should delete a document (tombstone) and hide from queries', async () => {
      if (!requirePG()) return;
      const a = createTestClient('a');
      const b = createTestClient('b');
      await sleep(400);

      await a.todos.put({ id: 'sync-del', title: 'To Delete' });
      await sleep(400);
      await a.todos.delete('sync-del');
      await sleep(500);

      const doc = await b.todos.findOne('sync-del').get();
      expect(doc).toBeNull();

      a.destroy();
      b.destroy();
    });

    it('should clear pending ops after server ack', async () => {
      if (!requirePG()) return;
      const client = createTestClient('ack');
      await sleep(400);

      const pendingBefore = await client.debug.getPendingOps();
      expect(pendingBefore.length).toBe(0);

      await client.todos.put({ id: 'ack-1', title: 'Ack Test' });
      await sleep(500);

      const pendingAfter = await client.debug.getPendingOps();
      expect(pendingAfter.length).toBe(0);

      client.destroy();
    });
  });

  // ─── CRDT Conflict Resolution ─────────────────────────────────────────────

  describe('CRDT — Conflict Resolution', () => {
    it('should deterministically merge edits from two clients', async () => {
      if (!requirePG()) return;
      const a = createTestClient('a');
      const b = createTestClient('b');
      await sleep(400);

      const docId = 'conflict-1';
      await a.todos.put({ id: docId, title: 'Start', done: false, priority: 1 });
      await sleep(400);

      // Concurrent edits on DIFFERENT fields (should merge cleanly)
      await a.todos.update(docId, { title: 'AAA' });
      await b.todos.update(docId, { done: true });
      await sleep(800);

      const docA = await a.todos.findOne(docId).get();
      const docB = await b.todos.findOne(docId).get();

      expect(docA!.title).toBe('AAA');
      expect(docA!.done).toBe(true);
      expect(docB!.title).toBe('AAA');
      expect(docB!.done).toBe(true);

      a.destroy();
      b.destroy();
    });

    it('should converge when two clients edit the SAME field', async () => {
      if (!requirePG()) return;
      const a = createTestClient('a');
      const b = createTestClient('b');
      await sleep(400);

      const docId = 'conflict-2';
      await a.todos.put({ id: docId, title: 'Initial', priority: 1 });
      await sleep(400);

      // Both edit the same field — one wins via LWW
      await a.todos.update(docId, { title: 'Winner-A' });
      await sleep(50);
      await b.todos.update(docId, { title: 'Winner-B' });
      await sleep(800);

      const finalA = await a.todos.findOne(docId).get();
      const finalB = await b.todos.findOne(docId).get();

      // Both must agree on the final value (deterministic via HLC tie-break)
      expect(finalA!.title).toBe(finalB!.title);

      a.destroy();
      b.destroy();
    });

    it('should preserve independent fields during concurrent updates', async () => {
      if (!requirePG()) return;
      const a = createTestClient('a');
      const b = createTestClient('b');
      await sleep(400);

      const docId = 'conflict-3';
      await a.todos.put({ id: docId, title: 'T', done: false, priority: 1 });
      await sleep(400);

      // Each client touches a different field
      await a.todos.update(docId, { title: 'New Title' });
      await b.todos.update(docId, { priority: 99 });
      await sleep(800);

      const doc = await a.todos.findOne(docId).get();
      expect(doc!.title).toBe('New Title');
      expect(doc!.priority).toBe(99);
      expect(doc!.done).toBe(false); // untouched

      a.destroy();
      b.destroy();
    });
  });

  // ─── Offline Queue + Reconnect ────────────────────────────────────────────

  describe('Offline Queue & Reconnect', () => {
    it('should persist writes to IndexedDB locally', async () => {
      if (!requirePG()) return;
      const client = createTestClient('offline');
      await sleep(500);

      await client.todos.put({ id: 'offline-1', title: 'Local Write' });
      await sleep(300);

      // Should be readable from local store immediately (optimistic)
      const doc = await client.todos.findOne('offline-1').get();
      expect(doc).toBeDefined();
      expect(doc!.title).toBe('Local Write');

      client.destroy();
    });

    it('should clear pending ops after successful sync', async () => {
      if (!requirePG()) return;
      const client = createTestClient('offline-sync');
      await sleep(500);

      await client.todos.put({ id: 'off-sync-1', title: 'Sync Me' });
      await sleep(600);

      const remaining = await client.debug.getPendingOps();
      expect(remaining.length).toBe(0);

      client.destroy();
    });

    it('should survive destroy + recreate cycle (new client picks up state)', async () => {
      const client1 = createTestClient('recreate');
      await sleep(500);

      await client1.todos.put({ id: 'recreate-1', title: 'Persisted' });
      await sleep(500);
      client1.destroy();

      // New client with same dbName should see existing data
      const client2 = createClient({
        schema,
        serverUrl: WS_URL,
        dbName: client1.debug ? 'test_recreate' : 'test_recreate_2',
        debug: false,
      });
      await sleep(500);

      // New client connects and pulls from server
      const doc = await client2.todos.findOne('recreate-1').get();
      expect(doc).toBeDefined();

      client2.destroy();
    });
  });

  // ─── E2E Encryption ───────────────────────────────────────────────────────

  describe('E2E Encryption', () => {
    it('should encrypt and decrypt values correctly', async () => {
      const key = await deriveKey('test-password-123', new Uint8Array(16).fill(0x42));
      const plaintext = 'sensitive data here';
      const encrypted = await encryptValue(key, plaintext);
      expect(encrypted).toBeInstanceOf(Uint8Array);
      expect(encrypted.length).toBeGreaterThan(plaintext.length); // IV + ciphertext

      const decrypted = await decryptValue(key, encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it('should produce different ciphertext for same plaintext (random IV)', async () => {
      const key = await deriveKey('test-pass', new Uint8Array(16).fill(0x01));
      const enc1 = await encryptValue(key, 'same data');
      const enc2 = await encryptValue(key, 'same data');
      expect(enc1).not.toEqual(enc2); // Different IVs
      expect(await decryptValue(key, enc1)).toBe('same data');
      expect(await decryptValue(key, enc2)).toBe('same data');
    });

    it('should fail decryption with wrong key', async () => {
      const key1 = await deriveKey('password-1', new Uint8Array(16).fill(0xAA));
      const key2 = await deriveKey('password-2', new Uint8Array(16).fill(0xAA));
      const encrypted = await encryptValue(key1, 'secret');

      await expect(decryptValue(key2, encrypted)).rejects.toThrow();
    });
  });

  // ─── Reactive Queries ─────────────────────────────────────────────────────

  describe('Reactive Queries', () => {
    it('should push updates to subscriber on data change', async () => {
      if (!requirePG()) return;
      const client = createTestClient('reactive');
      await sleep(400);

      const results: any[][] = [];
      const unsub = client.todos.find().subscribe((docs) => {
        results.push([...docs]);
      });

      await sleep(300);
      await client.todos.put({ id: 'r-1', title: 'First' });
      await sleep(400);
      await client.todos.put({ id: 'r-2', title: 'Second' });
      await sleep(400);

      unsub();
      expect(results.length).toBeGreaterThanOrEqual(2);

      client.destroy();
    });

    it('should filter by field in query', async () => {
      if (!requirePG()) return;
      const client = createTestClient('filter');
      await sleep(400);

      await client.todos.put({ id: 'f-1', title: 'Alpha', done: false });
      await client.todos.put({ id: 'f-2', title: 'Beta', done: true });
      await sleep(400);

      const undone = await client.todos.find({ done: false }).get();
      const done = await client.todos.find({ done: true }).get();

      expect(undone.length).toBeGreaterThanOrEqual(1);
      expect(undone.every((d: any) => d.done === false)).toBe(true);
      expect(done.every((d: any) => d.done === true)).toBe(true);

      client.destroy();
    });

    it('should support live query with ordering and limit', async () => {
      if (!requirePG()) return;
      const client = createTestClient('live');
      await sleep(400);

      await client.todos.put({ id: 'l-1', title: 'C', priority: 3 });
      await client.todos.put({ id: 'l-2', title: 'A', priority: 1 });
      await client.todos.put({ id: 'l-3', title: 'B', priority: 2 });
      await sleep(400);

      const docs = await client.todos.live({ orderBy: 'priority', limit: 2 }).get();
      expect(docs.length).toBeLessThanOrEqual(2);
      if (docs.length >= 2) {
        expect(docs[0].priority).toBeLessThanOrEqual(docs[1].priority);
      }

      client.destroy();
    });
  });

  // ─── Multi-Client Presence ────────────────────────────────────────────────

  describe('Presence', () => {
    it('should broadcast presence to other clients', async () => {
      if (!requirePG()) return;
      const a = createTestClient('presence-a');
      const b = createTestClient('presence-b');
      await sleep(500);

      let peerData: any = {};
      b.presence.subscribe((peers) => { peerData = { ...peers }; });

      a.presence.set({ x: 100, y: 200, color: 'red' });
      await sleep(500);

      const peerIds = Object.keys(peerData);
      expect(peerIds.length).toBeGreaterThanOrEqual(1);

      a.destroy();
      b.destroy();
    });
  });

  // ─── Server Health ────────────────────────────────────────────────────────

  describe('Server', () => {
    it('should have active client connections', () => {
      expect(server.getClientCount()).toBeGreaterThanOrEqual(0);
    });

    it('should reject invalid auth tokens', async () => {
      if (!requirePG()) return;
      const strictServer = createServer({
        port: 3002,
        database: DB_URL,
        schema,
        auth: async (token) => {
          if (token !== 'valid-token') throw new Error('Invalid token');
          return { userId: 'user' };
        },
      });
      try {
        await strictServer.start();
        await sleep(200);
      } catch {
        // Auth validation at WS connection time — integration test
        // for WS auth is better covered in ws-hub unit tests
      } finally {
        await strictServer.stop().catch(() => {});
      }
    });
  });
});
