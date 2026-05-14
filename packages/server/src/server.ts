/**
 * Meridian Server — Main Entry Point
 *
 * `createServer()` wires together all server components:
 * - PostgreSQL store (auto-DDL, CRDT merge)
 * - WebSocket hub (auth, connections)
 * - Merge engine (push/pull processing)
 * - Presence manager
 * - Compaction scheduler
 *
 * Usage:
 * ```ts
 * import { createServer } from 'meridian-server';
 * import { defineSchema, z } from 'meridian-shared';
 *
 * const schema = defineSchema({
 *   version: 1,
 *   collections: {
 *     todos: { id: z.string(), title: z.string(), done: z.boolean() },
 *   },
 * });
 *
 * const server = createServer({
 *   port: 3000,
 *   database: 'postgresql://user:pass@localhost:5432/mydb',
 *   schema,
 * });
 *
 * await server.start();
 * ```
 */

import type { SchemaDefinition, ConflictRecord, PermissionRules } from 'meridian-shared';
import { PgStore } from './pg-store.js';
import { WsHub, type AuthResult } from './ws-hub.js';
import { MergeEngine } from './merge.js';
import { ServerPresenceManager } from './presence.js';
import { CompactionManager } from './compaction.js';

// ─── Configuration ───────────────────────────────────────────────────────────

export interface MeridianServerConfig {
  /** Port for WebSocket server */
  port: number;

  /** PostgreSQL connection string */
  database: string;

  /** Schema definition (same as client) */
  schema: SchemaDefinition;

  /** WebSocket path (default: '/sync') */
  path?: string;

  /**
   * Authentication handler.
   * Called with the token from client's auth message.
   * Return user info or throw to reject.
   */
  auth?: (token: string) => Promise<AuthResult>;

  /**
   * Compaction settings for tombstone cleanup.
   */
  compaction?: {
    /** Max age for tombstones in ms (default: 30 days) */
    tombstoneMaxAge?: number;
    /** Compaction interval in ms (default: 24 hours) */
    interval?: number;
  };

  /**
   * Conflict handler — called when a field-level conflict is resolved.
   * Use this to implement custom merge logic for specific collections or fields.
   */
  onConflict?: (conflict: ConflictRecord & { collection: string; docId: string }) => void;

  /**
   * Permission rules for row-level access control.
   * When provided, only rows the user is authorized to read are returned.
   *
   * ```ts
   * permissions: defineRules({
   *   todos: {
   *     read: (auth, doc) => auth?.userId === doc.existing?.ownerId,
   *     write: (auth, doc) => auth != null,
   *   }
   * })
   * ```
   */
  permissions?: PermissionRules;

  /**
   * Enable debug logging.
   * @default false
   */
  debug?: boolean;
}

// ─── Server Interface ────────────────────────────────────────────────────────

export interface MeridianServer {
  /** Start the server */
  start(): Promise<void>;
  /** Stop the server gracefully */
  stop(): Promise<void>;
  /** Run compaction manually */
  compact(): Promise<number>;
  /** Get connected client count */
  getClientCount(): number;
}

// ─── createServer ────────────────────────────────────────────────────────────

/**
 * Create a Meridian sync server.
 */
export function createServer(config: MeridianServerConfig): MeridianServer {
  const {
    port,
    database,
    schema,
    path = '/sync',
    auth,
    compaction,
    onConflict,
    permissions,
    debug = false,
  } = config;

  // Initialize PostgreSQL store
  const pgStore = new PgStore({
    connectionString: database,
    schema,
  });

  // Initialize WebSocket hub (constructed but not started yet)
  let mergeEngine: MergeEngine;
  let presenceManager: ServerPresenceManager;

  const wsHub = new WsHub({
    port,
    path,
    auth,
    debug,
    onMessage: (clientId, msg, client) => {
      switch (msg.type) {
        case 'push':
          mergeEngine.processPush(clientId, msg.ops, client);
          break;

        case 'pull':
          mergeEngine.processPull(clientId, msg.since, client);
          break;

        case 'presence':
          presenceManager.update(clientId, msg.data, client);
          break;

        default:
          // subscribe and auth are handled in WsHub
          break;
      }
    },
    onDisconnect: (clientId) => {
      presenceManager.remove(clientId);
      mergeEngine.removeClientFilter(clientId);
    },
    onSubscribe: (clientId, collections, filter) => {
      mergeEngine.setClientFilter(clientId, collections, filter);
    },
  });

  // Initialize merge engine
  mergeEngine = new MergeEngine({
    pgStore,
    wsHub,
    debug,
    onConflict,
    permissions,
  });

  // Initialize presence manager
  presenceManager = new ServerPresenceManager(wsHub, debug);

  // Initialize compaction scheduler
  const compactionManager = new CompactionManager(pgStore, wsHub, {
    tombstoneMaxAge: compaction?.tombstoneMaxAge,
    interval: compaction?.interval,
    debug,
  });

  // Listen for PostgreSQL changes and broadcast to clients
  pgStore.onChange((tableName, docId) => {
    if (debug) {
      console.log(`[Meridian Server] 📢 DB change: ${tableName}/${docId}`);
    }
  });

  return {
    async start() {
      if (debug) {
        console.log('[Meridian Server] 🚀 Starting...');
        console.log(`[Meridian Server] 📦 Schema v${schema.version}: ${Object.keys(schema.collections).join(', ')}`);
        console.log(`[Meridian Server] 🐘 Database: ${database.replace(/\/\/.*@/, '//***@')}`);
      }

      // Initialize PostgreSQL (create tables, triggers, etc.)
      await pgStore.init();

      // Start WebSocket server
      wsHub.start();

      // Start compaction scheduler
      compactionManager.start();

      if (debug) {
        console.log(`[Meridian Server] ✅ Ready on ws://localhost:${port}${path}`);
      }
    },

    async stop() {
      if (debug) {
        console.log('[Meridian Server] 🛑 Stopping...');
      }

      compactionManager.stop();
      wsHub.stop();
      presenceManager.clear();
      await pgStore.close();

      if (debug) {
        console.log('[Meridian Server] ✅ Stopped');
      }
    },

    async compact() {
      return compactionManager.runCompaction();
    },

    getClientCount() {
      return wsHub.getClientIds().length;
    },
  };
}
