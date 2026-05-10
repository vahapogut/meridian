import { ClientMessage, ServerMessage, SchemaDefinition, ConflictRecord, CRDTOperation, ServerChange } from '@meridian-sync/shared';
export { CRDTOperation, ConflictRecord, SchemaDefinition, ServerChange, defineSchema, z } from '@meridian-sync/shared';
import { WebSocket } from 'ws';

/**
 * Meridian Server — WebSocket Hub
 *
 * Manages WebSocket connections with:
 * - Client authentication (pluggable JWT verifier)
 * - Namespace isolation (multi-tenant)
 * - Message routing (push/pull/subscribe/presence)
 * - Heartbeat/ping-pong health checks
 * - Auth token expiry tracking and refresh notifications
 */

interface AuthResult {
    userId: string;
    namespace?: string;
    expiresAt?: number;
}
interface WsHubConfig {
    /** Port to listen on */
    port: number;
    /** Path for WebSocket endpoint */
    path?: string;
    /** Auth verifier — return user info or throw to reject */
    auth?: (token: string) => Promise<AuthResult>;
    /** Message handler */
    onMessage: (clientId: string, message: ClientMessage, client: ConnectedClient) => void;
    /** Disconnect handler */
    onDisconnect?: (clientId: string) => void;
    /** Debug mode */
    debug?: boolean;
}
interface ConnectedClient {
    id: string;
    ws: WebSocket;
    userId: string | null;
    namespace: string | null;
    subscribedCollections: Set<string>;
    authExpiresAt: number | null;
    lastActivity: number;
}
/**
 * WebSocket connection hub for Meridian server.
 */
declare class WsHub {
    private wss;
    private readonly config;
    private clients;
    private heartbeatInterval;
    private authCheckInterval;
    constructor(config: WsHubConfig);
    /**
     * Start the WebSocket server.
     */
    start(): void;
    /**
     * Stop the WebSocket server.
     */
    stop(): void;
    private handleConnection;
    private handleClientMessage;
    /**
     * Send a message to a specific client.
     */
    sendTo(client: ConnectedClient, msg: ServerMessage): void;
    /**
     * Send a message to a client by ID.
     */
    sendToId(clientId: string, msg: ServerMessage): void;
    /**
     * Broadcast a message to all clients subscribed to a collection.
     * Excludes the sender.
     */
    broadcastToCollection(collection: string, msg: ServerMessage, excludeClientId?: string, namespace?: string | null): void;
    /**
     * Broadcast a message to all connected clients.
     */
    broadcastToAll(msg: ServerMessage, namespace?: string | null): void;
    /**
     * Get all connected client IDs.
     */
    getClientIds(): string[];
    /**
     * Get a connected client by ID.
     */
    getClient(clientId: string): ConnectedClient | undefined;
    private startHeartbeat;
    private startAuthCheck;
    private log;
}

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
 * import { createServer } from '@meridian-sync/server';
 * import { defineSchema, z } from '@meridian-sync/shared';
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

interface MeridianServerConfig {
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
     */
    onConflict?: (conflict: ConflictRecord & {
        collection: string;
        docId: string;
    }) => void;
    /**
     * Enable debug logging.
     * @default false
     */
    debug?: boolean;
}
interface MeridianServer {
    /** Start the server */
    start(): Promise<void>;
    /** Stop the server gracefully */
    stop(): Promise<void>;
    /** Run compaction manually */
    compact(): Promise<number>;
    /** Get connected client count */
    getClientCount(): number;
}
/**
 * Create a Meridian sync server.
 */
declare function createServer(config: MeridianServerConfig): MeridianServer;

/**
 * Meridian Server — PostgreSQL Store
 *
 * Handles:
 * - Auto-creation of tables from client schema
 * - CRDT metadata storage via _meridian_meta JSONB column
 * - Server-assigned monotonic sequence numbers
 * - LISTEN/NOTIFY for change detection
 * - Tombstone compaction
 * - Changes-since queries for pull protocol
 */

interface PgStoreConfig {
    /** PostgreSQL connection string */
    connectionString: string;
    /** Schema definition */
    schema: SchemaDefinition;
    /** Optional namespace prefix for multi-tenant isolation */
    namespace?: string;
}
/**
 * PostgreSQL storage adapter for Meridian server.
 */
declare class PgStore {
    private pool;
    private readonly config;
    private changeCallbacks;
    private listenClient;
    private minSeq;
    constructor(config: PgStoreConfig);
    /**
     * Initialize the database — create tables, sequences, triggers.
     */
    init(): Promise<void>;
    /**
     * Get the table name with optional namespace prefix.
     */
    private tableName;
    /**
     * Create a table for a collection with Meridian system columns.
     */
    private createTable;
    /**
     * Apply CRDT operations from a client.
     * Performs field-level LWW merge with existing data.
     * @returns Array of server changes with assigned sequence numbers and any conflicts
     */
    applyOperations(ops: CRDTOperation[]): Promise<{
        changes: ServerChange[];
        conflicts: ConflictRecord[];
    }>;
    /**
     * Get all changes since a given sequence number.
     * Used for pull protocol.
     *
     * @returns null if seqNum is below minSeq (compaction gap), otherwise changes
     */
    getChangesSince(since: number): Promise<ServerChange[] | null>;
    /**
     * Get the current minimum available sequence number.
     */
    getMinSeq(): number;
    /**
     * Delete tombstoned rows older than maxAge.
     * @returns Number of rows deleted
     */
    compact(maxAgeMs: number): Promise<number>;
    private updateMinSeq;
    private startListening;
    /**
     * Register a callback for database changes.
     */
    onChange(callback: (tableName: string, docId: string) => void): () => void;
    /**
     * Close the database connection pool.
     */
    close(): Promise<void>;
}

/**
 * Meridian Server — CRDT Merge Engine
 *
 * Handles server-side merge logic:
 * - Receives client operations
 * - Merges with existing PostgreSQL state
 * - Assigns sequence numbers
 * - Broadcasts results to other clients
 * - Logs conflicts for debugging
 */

interface MergeEngineConfig {
    pgStore: PgStore;
    wsHub: WsHub;
    debug?: boolean;
    /** Custom conflict handler */
    onConflict?: (conflict: ConflictRecord & {
        collection: string;
        docId: string;
    }) => void;
}
/**
 * Server-side CRDT merge engine.
 */
declare class MergeEngine {
    private readonly config;
    private conflictLog;
    private readonly maxConflictLog;
    constructor(config: MergeEngineConfig);
    /**
     * Process a push from a client.
     * Merges operations with existing state, assigns seqNums, and broadcasts.
     *
     * @param clientId - The sending client's ID
     * @param ops - CRDT operations from the client
     * @param client - The connected client object
     */
    processPush(clientId: string, ops: CRDTOperation[], client: ConnectedClient): Promise<void>;
    /**
     * Process a pull request from a client.
     * Returns changes since the given sequence number.
     */
    processPull(clientId: string, since: number, client: ConnectedClient): Promise<void>;
    /**
     * Get the conflict log.
     */
    getConflictLog(): (ConflictRecord & {
        collection: string;
        docId: string;
        timestamp: number;
    })[];
    private log;
}

/**
 * Meridian Server — Presence Manager (Server-side)
 *
 * In-memory presence state for connected clients.
 * - Stores presence data per client
 * - Broadcasts updates to all peers
 * - Auto-cleanup on disconnect (no TTL needed — instant)
 */

type PresenceData = Record<string, unknown>;
declare class ServerPresenceManager {
    private presence;
    private wsHub;
    private debug;
    constructor(wsHub: WsHub, debug?: boolean);
    /**
     * Update presence for a client and broadcast to peers.
     */
    update(clientId: string, data: PresenceData, client: ConnectedClient): void;
    /**
     * Remove presence for a disconnected client.
     */
    remove(clientId: string): void;
    /**
     * Get all current presence data.
     */
    getAll(): Record<string, PresenceData>;
    /**
     * Send current presence state to a specific client (e.g., on reconnect).
     */
    sendCurrentState(client: ConnectedClient): void;
    private broadcastAll;
    /**
     * Clear all presence data.
     */
    clear(): void;
}

/**
 * Meridian Server — Tombstone Compaction
 *
 * Periodically removes soft-deleted rows older than a configurable max age.
 * After compaction, notifies connected clients so they can clean up local data.
 */

interface CompactionConfig {
    /** Maximum age for tombstones in ms (default: 30 days) */
    tombstoneMaxAge: number;
    /** Compaction check interval in ms (default: 24 hours) */
    interval: number;
    /** Debug mode */
    debug?: boolean;
}
/**
 * Tombstone compaction scheduler.
 */
declare class CompactionManager {
    private readonly pgStore;
    private readonly wsHub;
    private readonly config;
    private timer;
    constructor(pgStore: PgStore, wsHub: WsHub, config?: Partial<CompactionConfig>);
    /**
     * Start the compaction scheduler.
     */
    start(): void;
    /**
     * Stop the compaction scheduler.
     */
    stop(): void;
    /**
     * Run compaction now.
     */
    runCompaction(): Promise<number>;
    private log;
}

export { type AuthResult, type CompactionConfig, CompactionManager, type ConnectedClient, MergeEngine, type MergeEngineConfig, type MeridianServer, type MeridianServerConfig, PgStore, type PgStoreConfig, ServerPresenceManager, WsHub, type WsHubConfig, createServer };
