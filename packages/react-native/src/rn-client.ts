/**
 * Meridian React Native Client
 *
 * Lightweight client for React Native environments.
 *
 * Key differences from browser client:
 * - AsyncStorage instead of IndexedDB for persistence
 * - No BroadcastChannel (mobile apps run in a single JS context)
 * - Same reactive API as the browser client
 */

import type { SchemaDefinition, ConnectionState, PendingOp, ConflictRecord } from 'meridian-shared';
import { HLC, generateNodeId } from 'meridian-shared';

// ─── Config ──────────────────────────────────────────────────────────────────

export interface RNClientConfig {
  /** Schema definition */
  schema: SchemaDefinition;
  /** WebSocket server URL (use wss:// in production) */
  serverUrl: string;
  /** Auth token provider */
  auth?: { getToken: () => Promise<string> };
  /** Debug mode */
  debug?: boolean;
}

export interface RNClient {
  readonly connectionState: ConnectionState;
  sync(): Promise<void>;
  destroy(): void;
  [collection: string]: unknown;
}

// ─── Simple Key-Value Store ──────────────────────────────────────────────────

interface KVStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

/**
 * AsyncStorage-backed key-value store for React Native.
 * Falls back to in-memory Map if AsyncStorage is not available (testing).
 */
class AsyncKVStore implements KVStore {
  private memoryFallback = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    try {
      const AsyncStorage = require('@react-native-async-storage/async-storage').default;
      return await AsyncStorage.getItem(`meridian:${key}`);
    } catch {
      return this.memoryFallback.get(key) ?? null;
    }
  }

  async set(key: string, value: string): Promise<void> {
    try {
      const AsyncStorage = require('@react-native-async-storage/async-storage').default;
      await AsyncStorage.setItem(`meridian:${key}`, value);
    } catch {
      this.memoryFallback.set(key, value);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      const AsyncStorage = require('@react-native-async-storage/async-storage').default;
      await AsyncStorage.removeItem(`meridian:${key}`);
    } catch {
      this.memoryFallback.delete(key);
    }
  }

  async keys(): Promise<string[]> {
    try {
      const AsyncStorage = require('@react-native-async-storage/async-storage').default;
      const allKeys = await AsyncStorage.getAllKeys();
      return allKeys
        .filter((k: string) => k.startsWith('meridian:'))
        .map((k: string) => k.replace('meridian:', ''));
    } catch {
      return Array.from(this.memoryFallback.keys());
    }
  }
}

// ─── Client ──────────────────────────────────────────────────────────────────

export function createRNClient(config: RNClientConfig): RNClient {
  const { schema, serverUrl, auth, debug = false } = config;
  const nodeId = generateNodeId();
  const clock = new HLC(nodeId);
  const store = new AsyncKVStore();
  const collections: Record<string, RNCollectionProxy> = {};

  let ws: WebSocket | null = null;
  let state: ConnectionState = 'disconnected';
  let destroyed = false;

  // Create collection proxies
  for (const name of Object.keys(schema.collections)) {
    const proxy = new RNCollectionProxy(name, store, clock, () => ws, serverUrl, auth, debug);
    collections[name] = proxy;
  }

  // Connect
  connect().catch(() => {});

  async function connect(): Promise<void> {
    if (destroyed) return;
    state = 'connecting';

    try {
      ws = new WebSocket(serverUrl);

      ws.onopen = async () => {
        state = 'connected';
        if (auth) {
          const token = await auth.getToken();
          ws?.send(JSON.stringify({ type: 'auth', token }));
        }
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string);
          // Ack/reject handling per collection proxy
          if (msg.type === 'ack' && msg.opIds) {
            for (const id of msg.opIds) {
              store.delete(`pending:${id}`).catch(() => {});
            }
          }
        } catch {
          // Ignore malformed messages
        }
      };

      ws.onerror = () => { state = 'error'; };
      ws.onclose = () => {
        state = 'disconnected';
        if (!destroyed) setTimeout(connect, 3000);
      };
    } catch {
      state = 'disconnected';
      if (!destroyed) setTimeout(connect, 5000);
    }
  }

  const client: RNClient = {
    get connectionState() { return state; },

    async sync() {
      if (ws && state === 'connected') {
        const pendingKeys = await store.keys();
        const ops = [];
        for (const key of pendingKeys) {
          if (key.startsWith('pending:')) {
            const opJson = await store.get(key);
            if (opJson) ops.push(JSON.parse(opJson));
          }
        }
        if (ops.length > 0) {
          ws.send(JSON.stringify({ type: 'push', ops }));
        }
      }
    },

    destroy() {
      destroyed = true;
      if (ws) { ws.onclose = null; ws.close(); ws = null; }
    },
  };

  // Attach collection accessors
  for (const [name, proxy] of Object.entries(collections)) {
    (client as any)[name] = proxy;
  }

  return client;
}

// ─── RN Collection Proxy ─────────────────────────────────────────────────────

class RNCollectionProxy {
  private collection: string;
  private store: KVStore;
  private clock: HLC;
  private getWs: () => WebSocket | null;
  private serverUrl: string;
  private auth: RNClientConfig['auth'];
  private debug: boolean;

  constructor(
    collection: string,
    store: KVStore,
    clock: HLC,
    getWs: () => WebSocket | null,
    serverUrl: string,
    auth: RNClientConfig['auth'],
    debug: boolean,
  ) {
    this.collection = collection;
    this.store = store;
    this.clock = clock;
    this.getWs = getWs;
    this.serverUrl = serverUrl;
    this.auth = auth;
    this.debug = debug;
  }

  find(filter?: Record<string, unknown>) {
    const self = this;
    const listeners: Set<(docs: Record<string, unknown>[]) => void> = new Set();

    return {
      subscribe(cb: (docs: Record<string, unknown>[]) => void) {
        listeners.add(cb);
        self.queryDocs(filter).then(cb);
        return () => { listeners.delete(cb); };
      },
      get: () => self.queryDocs(filter),
    };
  }

  findOne(id: string) {
    return {
      subscribe: (cb: (doc: Record<string, unknown> | null) => void) => {
        this.getDoc(id).then(cb);
        return () => {};
      },
      get: () => this.getDoc(id),
    };
  }

  live(options: { where?: Record<string, unknown>; orderBy?: string; limit?: number } = {}) {
    return this.find(options.where);
  }

  async put(doc: Record<string, unknown>) {
    if (!doc.id) doc.id = `rn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const hlcTs = this.clock.now();
    const hlcStr = `${hlcTs.wallTime}-${hlcTs.counter.toString().padStart(4, '0')}-${hlcTs.nodeId}`;

    await this.store.set(`doc:${this.collection}:${doc.id}`, JSON.stringify(doc));
    await this.queueOp(doc.id as string, Object.keys(doc).filter(k => k !== 'id'), doc, hlcStr);
    this.trySync();
  }

  async update(id: string, fields: Record<string, unknown>) {
    const existing = await this.getDoc(id);
    if (!existing) return;
    const merged = { ...existing, ...fields };
    await this.store.set(`doc:${this.collection}:${id}`, JSON.stringify(merged));

    const hlcTs = this.clock.now();
    const hlcStr = `${hlcTs.wallTime}-${hlcTs.counter.toString().padStart(4, '0')}-${hlcTs.nodeId}`;
    await this.queueOp(id, Object.keys(fields), fields, hlcStr);
    this.trySync();
  }

  async delete(id: string) {
    await this.store.set(`doc:${this.collection}:${id}:deleted`, 'true');
    this.trySync();
  }

  private async queryDocs(filter?: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    const allKeys = await this.store.keys();
    const docs: Record<string, unknown>[] = [];

    for (const key of allKeys) {
      if (!key.startsWith(`doc:${this.collection}:`)) continue;
      const id = key.split(':').pop()!;
      const deleted = await this.store.get(`doc:${this.collection}:${id}:deleted`);
      if (deleted === 'true') continue;

      const raw = await this.store.get(key);
      if (!raw) continue;
      const doc = JSON.parse(raw);

      if (filter) {
        let matches = true;
        for (const [k, v] of Object.entries(filter)) {
          if (doc[k] !== v) { matches = false; break; }
        }
        if (!matches) continue;
      }
      docs.push(doc);
    }
    return docs;
  }

  private async getDoc(id: string): Promise<Record<string, unknown> | null> {
    const raw = await this.store.get(`doc:${this.collection}:${id}`);
    if (!raw) return null;
    return JSON.parse(raw);
  }

  private async queueOp(docId: string, fields: string[], values: Record<string, unknown>, hlc: string) {
    for (const field of fields) {
      const op = {
        id: `${docId}-${field}-${hlc}`,
        collection: this.collection,
        docId,
        field,
        value: values[field],
        hlc,
        nodeId: this.clock.peek().nodeId,
      };
      await this.store.set(`pending:${op.id}`, JSON.stringify(op));
    }
  }

  private trySync() {
    const ws = this.getWs();
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    // Collect and send pending ops
    this.store.keys().then(async (keys) => {
      const ops = [];
      for (const key of keys) {
        if (key.startsWith('pending:')) {
          const raw = await this.store.get(key);
          if (raw) ops.push(JSON.parse(raw));
        }
      }
      if (ops.length > 0) {
        ws.send(JSON.stringify({ type: 'push', ops }));
      }
    });
  }
}
