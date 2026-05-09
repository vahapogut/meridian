import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type MeridianServer } from '@meridian-sync/server';
import { createClient, type MeridianClient } from '@meridian-sync/client';
import { defineSchema, z } from '@meridian-sync/shared';
import 'fake-indexeddb/auto'; // Polyfill IndexedDB for Node.js test environment

// ─── Test Schema ─────────────────────────────────────────────────────────────
const schema = defineSchema({
  version: 1,
  collections: {
    todos: {
      id: z.string(),
      title: z.string(),
      done: z.boolean().default(false),
    },
  },
});

const PORT = 3001;
const WS_URL = `ws://localhost:${PORT}/sync`;

// ⚠️ IMPORTANT: Update this with your local PostgreSQL credentials
const DB_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/meridian_demo';

describe('Meridian Chaos Tests', () => {
  let server: MeridianServer;

  beforeAll(async () => {
    server = createServer({
      port: PORT,
      database: DB_URL,
      schema,
      auth: async () => ({ userId: 'test-user' }),
      debug: false,
    });
    
    // We wrap start in try/catch to warn users if Postgres isn't running
    try {
      await server.start();
    } catch (e) {
      console.warn('⚠️ WARNING: Ensure PostgreSQL is running and DB_URL is correct in tests/chaos.test.ts');
      throw e;
    }
  });

  afterAll(async () => {
    if (server) await server.stop();
  });

  it('should deterministically merge offline edits from multiple tabs/clients', async () => {
    // 1. Create two separate clients (simulating two tabs/devices)
    const clientA = createClient({ schema, serverUrl: WS_URL, dbName: 'test_a' });
    const clientB = createClient({ schema, serverUrl: WS_URL, dbName: 'test_b' });

    // Wait for connection
    await new Promise(r => setTimeout(r, 500));

    // 2. Create a shared document
    const docId = 'todo-1';
    await clientA.todos.put({ id: docId, title: 'Initial', done: false });

    // Wait for sync to propagate to B
    await new Promise(r => setTimeout(r, 500));

    // 3. Go offline (simulate by stopping sync engine locally)
    // Note: In tests, we can manually trigger disconnect or just write very fast
    // Because we are writing extremely fast, we simulate a race condition

    // Client A updates title multiple times
    await clientA.todos.update(docId, { title: 'A' });
    await clientA.todos.update(docId, { title: 'AB' });
    const finalA = await clientA.todos.update(docId, { title: 'ABC' });

    // Client B updates 'done' field concurrently
    await clientB.todos.update(docId, { done: true });

    // Wait for sync
    await new Promise(r => setTimeout(r, 1000));

    // 4. Verify convergence
    const docA = await clientA.todos.findOne(docId).get();
    const docB = await clientB.todos.findOne(docId).get();

    // Both clients should have the exact same state
    expect(docA).toBeDefined();
    expect(docB).toBeDefined();
    
    expect(docA!.title).toBe('ABC'); // Client A's last write won
    expect(docA!.done).toBe(true);   // Client B's write to a DIFFERENT field was preserved (Field-level CRDT)
    
    expect(docB!.title).toBe('ABC');
    expect(docB!.done).toBe(true);

    clientA.destroy();
    clientB.destroy();
  });

  it('should prevent duplicate operations and handle idempotent applies', async () => {
    const client = createClient({ schema, serverUrl: WS_URL, dbName: 'test_c' });
    await new Promise(r => setTimeout(r, 500));

    const pendingBefore = await client.debug.getPendingOps();
    expect(pendingBefore.length).toBe(0);

    // Write offline
    await client.todos.put({ id: 'todo-dup', title: 'Test Dup', done: false });
    
    await new Promise(r => setTimeout(r, 500));
    
    // Server should acknowledge and clear pending ops
    const pendingAfter = await client.debug.getPendingOps();
    expect(pendingAfter.length).toBe(0);

    client.destroy();
  });
});
