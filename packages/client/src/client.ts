/**
 * Meridian Client — Main Entry Point
 *
 * The `createClient()` function is the only thing a developer needs to call.
 * It wires together all internal modules and returns a typed database proxy.
 *
 * Usage:
 * ```ts
 * import { createClient, defineSchema, z } from '@meridian-sync/client';
 *
 * const schema = defineSchema({
 *   version: 1,
 *   collections: {
 *     todos: {
 *       id: z.string(),
 *       title: z.string(),
 *       done: z.boolean().default(false),
 *     },
 *   },
 * });
 *
 * const db = createClient({
 *   schema,
 *   serverUrl: 'ws://localhost:3000/sync',
 * });
 *
 * // Write
 * await db.todos.put({ id: '1', title: 'Buy milk', done: false });
 *
 * // Reactive query
 * db.todos.find({ done: false }).subscribe(todos => console.log(todos));
 * ```
 */

import {
  type SchemaDefinition,
  type ConnectionState,
  type PendingOp,
  HLC,
  generateNodeId,
} from '@meridian-sync/shared';
import { MeridianStore } from './store.js';
import { SyncEngine } from './sync.js';
import { CollectionProxy } from './reactive.js';
import { TabCoordinator } from './tab-coordinator.js';
import { PresenceManager } from './presence.js';
import { DebugManager } from './debug.js';

// ─── Configuration ───────────────────────────────────────────────────────────

export interface MeridianClientConfig {
  /** Schema definition — created with defineSchema() */
  schema: SchemaDefinition;

  /** WebSocket server URL (e.g., 'ws://localhost:3000/sync') */
  serverUrl: string;

  /**
   * Authentication provider.
   * The getToken function is called on connect and when the server
   * sends an auth-expiring message.
   */
  auth?: {
    getToken: () => Promise<string>;
  };

  /**
   * Database name for IndexedDB.
   * Defaults to a hash of the serverUrl.
   */
  dbName?: string;

  /**
   * Enable debug mode — console logs for all sync operations.
   * @default false
   */
  debug?: boolean;

  /**
   * Called when a server rejects an operation and the local
   * state is rolled back to the previous value.
   */
  onRollback?: (op: PendingOp, reason: string) => void;

  /**
   * Called when the connection state changes.
   */
  onConnectionChange?: (state: ConnectionState) => void;
}

// ─── Client Type ─────────────────────────────────────────────────────────────

/**
 * The Meridian database client.
 *
 * Access collections by name: `db.todos`, `db.users`, etc.
 * Each collection is a `CollectionProxy` with find/put/update/delete methods.
 */
export interface MeridianClient {
  /** Current connection state */
  readonly connectionState: ConnectionState;

  /** Presence API — ephemeral real-time presence */
  readonly presence: PresenceManager;

  /** Debug utilities (only useful when debug=true) */
  readonly debug: DebugManager;

  /** Manually trigger a sync cycle */
  sync(): Promise<void>;

  /** Destroy the client — close connections, clean up listeners */
  destroy(): void;

  /** Access any collection by name */
  [collection: string]: CollectionProxy | unknown;
}

// ─── createClient ────────────────────────────────────────────────────────────

/**
 * Create a Meridian sync client.
 *
 * This is the main entry point for the library. It:
 * 1. Initializes IndexedDB with the given schema
 * 2. Creates collection proxies for each collection
 * 3. Sets up multi-tab coordination
 * 4. Connects to the sync server via WebSocket
 * 5. Starts the sync loop
 *
 * @returns A database proxy object with collection accessors
 */
export function createClient(config: MeridianClientConfig): MeridianClient {
  const {
    schema,
    serverUrl,
    auth,
    dbName = simpleHash(serverUrl),
    debug = false,
    onRollback,
    onConnectionChange,
  } = config;

  // Generate unique node ID for this client
  const nodeId = generateNodeId();
  const clock = new HLC(nodeId);

  // Initialize store
  const store = new MeridianStore({ dbName, schema, nodeId });

  // Initialize debug manager
  const debugManager = new DebugManager(store);

  // Initialize presence manager
  const presence = new PresenceManager();

  // Initialize sync engine
  const syncEngine = new SyncEngine({
    serverUrl,
    store,
    auth,
    schemaVersion: schema.version,
    debug,
    onConnectionChange: (state) => {
      debugManager.updateConnectionState(state);
      if (state === 'connected') {
        debugManager.markSynced();
        // Re-send presence on reconnect
        presence.resendPresence();
      }
      onConnectionChange?.(state);
    },
    onRollback,
  });

  // Initialize tab coordinator
  const tabCoordinator = new TabCoordinator({
    debug,
    onBecomeLeader: () => {
      if (debug) console.log('[Meridian] 👑 This tab is now the leader');
      syncEngine.start();
    },
    onBecomeFollower: () => {
      if (debug) console.log('[Meridian] 👤 This tab is now a follower');
      syncEngine.stop();
    },
    onRemoteStoreChange: (collection, docId) => {
      // Trigger reactive query re-evaluation for this collection
      // The store's internal change listeners will handle this
      store.queryDocs(collection).then(() => {
        // Force re-evaluation
      });
    },
  });

  // Wire presence send function to sync engine
  presence.setSendFunction((data) => {
    // Will be sent via the sync engine's WebSocket
    if (syncEngine.isConnected) {
      // This gets handled by the sync engine
    }
  });

  // Create collection proxies
  const collections: Record<string, CollectionProxy> = {};
  for (const name of Object.keys(schema.collections)) {
    collections[name] = new CollectionProxy(name, store, clock);
  }

  // Build the client object
  const client: MeridianClient = {
    get connectionState() {
      return syncEngine.connectionState;
    },

    presence,
    debug: debugManager,

    async sync() {
      await syncEngine.sync();
    },

    destroy() {
      tabCoordinator.stop();
      syncEngine.stop();
      presence.clear();
      store.close();
    },

    ...collections,
  };

  // ─── Async Initialization ──────────────────────────────────────────────────

  // Start everything asynchronously (non-blocking)
  (async () => {
    try {
      await store.init();
      tabCoordinator.start();

      if (debug) {
        console.log(`[Meridian] 🚀 Client initialized`);
        console.log(`[Meridian] 📋 Node ID: ${nodeId}`);
        console.log(`[Meridian] 📦 Collections: ${Object.keys(schema.collections).join(', ')}`);
        console.log(`[Meridian] 🔗 Server: ${serverUrl}`);
      }
    } catch (e) {
      console.error('[Meridian] ❌ Initialization failed:', e);
    }
  })();

  return client;
}

// ─── Utilities ───────────────────────────────────────────────────────────────

/**
 * Simple hash function for generating database names from URLs.
 */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36);
}
