import { SchemaDefinition, LWWMap, PendingOp, CRDTOperation, HLC, ConflictRecord, ConnectionState, ClientMessage } from '@meridian-sync/shared';
export { ConflictRecord, ConnectionState, PendingOp, SchemaDefinition, defineSchema, z } from '@meridian-sync/shared';

/**
 * Meridian Client — IndexedDB Store
 *
 * Persistent storage layer using IndexedDB (via `idb` library).
 * Manages three object stores:
 * - Per-collection stores: Documents with CRDT metadata
 * - `_meridian_meta`: CRDT metadata (HLC per field) per document
 * - `_meridian_pending`: Pending operations queue for offline sync
 */

interface StoreConfig {
    /** Database name (derived from server URL or custom) */
    dbName: string;
    /** Schema definition */
    schema: SchemaDefinition;
    /** Node ID for this client */
    nodeId: string;
}
interface DocWithMeta {
    /** Plain document values */
    doc: Record<string, unknown>;
    /** CRDT metadata map */
    crdtMap: LWWMap;
}
/**
 * IndexedDB-backed store for Meridian client.
 *
 * Handles:
 * - Document CRUD with CRDT metadata
 * - Pending operations queue (offline writes)
 * - Sync state persistence (last known seqNum)
 */
declare class MeridianStore {
    private db;
    private readonly config;
    private changeListeners;
    constructor(config: StoreConfig);
    /**
     * Initialize IndexedDB — creates/upgrades stores as needed.
     */
    init(): Promise<void>;
    private ensureDB;
    /**
     * Get a single document by ID.
     * Returns null if not found or soft-deleted.
     */
    getDoc(collection: string, docId: string): Promise<Record<string, unknown> | null>;
    /**
     * Get a document with its CRDT metadata.
     */
    getDocWithMeta(collection: string, docId: string): Promise<DocWithMeta | null>;
    /**
     * Put a document (create or update).
     * Writes both the document and CRDT metadata.
     *
     * @returns The pending operation created
     */
    putDoc(collection: string, doc: Record<string, unknown>, hlc: string, nodeId: string): Promise<PendingOp[]>;
    /**
     * Update specific fields of a document.
     */
    updateDoc(collection: string, docId: string, fields: Record<string, unknown>, hlc: string, nodeId: string): Promise<PendingOp[]>;
    /**
     * Soft-delete a document (tombstone).
     */
    deleteDoc(collection: string, docId: string, hlc: string, nodeId: string): Promise<PendingOp[]>;
    /**
     * Query all non-deleted documents in a collection.
     * Supports simple field-value filtering.
     */
    queryDocs(collection: string, filter?: Record<string, unknown>): Promise<Record<string, unknown>[]>;
    /**
     * Apply remote changes from server to local store.
     * Performs CRDT merge — only accepts changes with higher HLC.
     */
    applyRemoteChanges(ops: CRDTOperation[]): Promise<string[]>;
    private getMeta;
    /**
     * Get all pending operations (not yet acknowledged by server).
     */
    getPendingOps(): Promise<PendingOp[]>;
    /**
     * Mark operations as sending (in-flight to server).
     */
    markOpsSending(opIds: string[]): Promise<void>;
    /**
     * Acknowledge operations (server confirmed persistence).
     */
    ackOps(opIds: string[]): Promise<void>;
    /**
     * Rollback rejected operations to their previous values.
     */
    rollbackOp(opId: string): Promise<PendingOp | null>;
    /**
     * Reset all pending ops to 'pending' status (e.g., on reconnect).
     */
    resetPendingStatus(): Promise<void>;
    /**
     * Get the last known server sequence number.
     */
    getLastSeq(): Promise<number>;
    /**
     * Update the last known server sequence number.
     */
    setLastSeq(seq: number): Promise<void>;
    /**
     * Clear all data (used for full re-sync after compaction gap).
     */
    clearAll(): Promise<void>;
    /**
     * Register a listener for document changes in a collection.
     */
    onCollectionChange(collection: string, listener: (docId: string) => void): () => void;
    notifyChange(collection: string, docId: string): void;
    /**
     * Close the database connection.
     */
    close(): void;
}

/**
 * Meridian Client — Reactive Query System
 *
 * Provides Observable-like queries that automatically re-execute
 * when underlying data changes. Powered by the store's change
 * listener system.
 *
 * Usage:
 * ```ts
 * db.todos.find({ done: false }).subscribe((todos) => {
 *   renderTodoList(todos);
 * });
 * ```
 */

type Subscriber<T> = (data: T) => void;
type Unsubscribe = () => void;
interface Query<T> {
    /** Subscribe to query results — callback fires on every data change */
    subscribe(callback: Subscriber<T>): Unsubscribe;
    /** Get current result (one-shot, non-reactive) */
    get(): Promise<T>;
}
/**
 * Proxy object for a collection — provides CRUD + reactive queries.
 *
 * Methods:
 * - find(filter?) — Reactive query for multiple documents
 * - findOne(id) — Reactive query for a single document
 * - put(doc) — Create or replace a document
 * - update(id, fields) — Update specific fields
 * - delete(id) — Soft-delete a document
 */
declare class CollectionProxy {
    private readonly collection;
    private readonly store;
    private readonly clock;
    constructor(collection: string, store: MeridianStore, clock: HLC);
    /**
     * Reactive query for multiple documents.
     *
     * @param filter - Optional field-value filter
     * @returns Query object with subscribe() and get()
     */
    find(filter?: Record<string, unknown>): Query<Record<string, unknown>[]>;
    /**
     * Reactive query for a single document by ID.
     *
     * @param id - Document ID
     * @returns Query object with subscribe() and get()
     */
    findOne(id: string): Query<Record<string, unknown> | null>;
    /**
     * Create or replace a document.
     *
     * If a document with the same ID exists, all fields are overwritten.
     * The operation is immediately written to IndexedDB and queued for sync.
     *
     * @param doc - Document with `id` field
     */
    put(doc: Record<string, unknown>): Promise<void>;
    /**
     * Update specific fields of an existing document.
     *
     * Only the specified fields are updated — other fields remain unchanged.
     * Generates field-level CRDT operations for minimal sync overhead.
     *
     * @param id - Document ID
     * @param fields - Fields to update
     */
    update(id: string, fields: Record<string, unknown>): Promise<void>;
    /**
     * Soft-delete a document.
     *
     * The document is marked as deleted (tombstone) but not physically removed.
     * It will be permanently removed during server-side compaction.
     *
     * @param id - Document ID
     */
    delete(id: string): Promise<void>;
}

/**
 * Meridian Client — Presence API
 *
 * Ephemeral presence data (cursors, status, etc.) that is:
 * - NOT persisted to IndexedDB
 * - Transmitted via WebSocket only
 * - Auto-re-sent on reconnect
 * - Cleaned up on disconnect (5s timeout server-side)
 */
type PresenceData = Record<string, unknown>;
type PresenceCallback = (peers: Record<string, PresenceData>) => void;
/**
 * Client-side presence manager.
 */
declare class PresenceManager {
    private localPresence;
    private peers;
    private listeners;
    private sendFn;
    /**
     * Set the function used to send presence over WebSocket.
     */
    setSendFunction(fn: (data: PresenceData) => void): void;
    /**
     * Set local presence data and broadcast to peers.
     *
     * Usage:
     * ```ts
     * db.presence.set({ cursor: { x: 100, y: 200 }, name: 'Alice' });
     * ```
     */
    set(data: PresenceData): void;
    /**
     * Subscribe to presence updates from all connected peers.
     *
     * Usage:
     * ```ts
     * db.presence.subscribe((peers) => {
     *   // peers: { "user-1": { cursor: {...}, name: "Bob" }, ... }
     *   renderCursors(peers);
     * });
     * ```
     */
    subscribe(callback: PresenceCallback): () => void;
    /**
     * Handle presence broadcast from server.
     * Called by the sync engine when a presence message arrives.
     */
    handleServerPresence(peers: Record<string, PresenceData>): void;
    /**
     * Re-send local presence after reconnect.
     * Called by the sync engine when WebSocket reconnects.
     */
    resendPresence(): void;
    /**
     * Clear all presence data.
     */
    clear(): void;
    private notifyListeners;
}

/**
 * Meridian Client — Debug Mode
 *
 * Provides visibility into sync state for development:
 * - Pending operations queue
 * - Conflict history
 * - Connection state
 * - Last sync time
 */

/**
 * Debug interface exposed as `db.debug` when debug mode is enabled.
 */
declare class DebugManager {
    private readonly store;
    private conflictHistory;
    private connectionState;
    private lastSyncTime;
    private readonly maxConflictHistory;
    constructor(store: MeridianStore);
    /**
     * Get all pending operations (not yet confirmed by server).
     */
    getPendingOps(): Promise<PendingOp[]>;
    /**
     * Get the last known server sequence number.
     */
    getLastSyncSeq(): Promise<number>;
    /**
     * Get the conflict history (limited to last 100 entries).
     */
    getConflictHistory(): ConflictRecord[];
    /**
     * Get the current connection state.
     */
    getConnectionState(): ConnectionState;
    /**
     * Get the timestamp of the last successful sync.
     */
    getLastSyncTime(): number | null;
    /** @internal */
    addConflict(conflict: ConflictRecord): void;
    /** @internal */
    updateConnectionState(state: ConnectionState): void;
    /** @internal */
    markSynced(): void;
}

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

interface MeridianClientConfig {
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
/**
 * The Meridian database client.
 *
 * Access collections by name: `db.todos`, `db.users`, etc.
 * Each collection is a `CollectionProxy` with find/put/update/delete methods.
 */
interface MeridianClient {
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
declare function createClient(config: MeridianClientConfig): MeridianClient;

/**
 * Meridian Client — WebSocket Sync Engine
 *
 * Handles:
 * - WebSocket connection with auto-reconnect (exponential backoff)
 * - Online/offline detection
 * - Push: Send pending operations to server
 * - Pull: Request changes since last known seqNum
 * - Ack: Mark operations as confirmed
 * - Reject: Rollback operations
 * - Auth: Token management with auto-refresh
 */

interface SyncConfig {
    /** WebSocket server URL */
    serverUrl: string;
    /** Store instance */
    store: MeridianStore;
    /** Auth token provider */
    auth?: {
        getToken: () => Promise<string>;
    };
    /** Schema version for compatibility check */
    schemaVersion: number;
    /** Debug mode */
    debug: boolean;
    /** Callbacks */
    onConnectionChange?: (state: ConnectionState) => void;
    onRollback?: (op: PendingOp, reason: string) => void;
    onConflict?: (details: {
        field: string;
        localValue: unknown;
        remoteValue: unknown;
    }) => void;
}
/**
 * WebSocket sync engine for Meridian client.
 */
declare class SyncEngine {
    private ws;
    private readonly config;
    private state;
    private retryDelay;
    private retryTimeout;
    private heartbeatInterval;
    private pushInProgress;
    private destroyed;
    constructor(config: SyncConfig);
    /**
     * Start the sync engine — connect to server.
     */
    start(): Promise<void>;
    /**
     * Stop the sync engine — disconnect and clean up.
     */
    stop(): void;
    /**
     * Force a manual sync cycle (push + pull).
     */
    sync(): Promise<void>;
    /**
     * Check if connected.
     */
    get isConnected(): boolean;
    /**
     * Current connection state.
     */
    get connectionState(): ConnectionState;
    private connect;
    private scheduleReconnect;
    private clearRetry;
    private startHeartbeat;
    private clearHeartbeat;
    private handleMessage;
    private handleAck;
    private handleReject;
    private handleChanges;
    private handleFullSyncRequired;
    private handleAuthExpiring;
    /**
     * Push all pending operations to the server.
     */
    pushPendingOps(): Promise<void>;
    /**
     * Pull changes from server since last known seqNum.
     */
    pullChanges(): Promise<void>;
    private handleOnline;
    private handleOffline;
    send(msg: ClientMessage): void;
    private setState;
    private log;
}

/**
 * Meridian Client — Tab Coordinator
 *
 * Uses BroadcastChannel API for multi-tab coordination:
 * - Leader election: Only one tab manages the WebSocket connection
 * - Store invalidation: Leader notifies followers when IndexedDB changes
 * - Seamless failover: If leader tab closes/crashes, a new leader is elected
 *
 * Mechanism:
 * 1. Each tab gets a monotonically increasing lockId on creation
 * 2. Leader sends heartbeats every 2s via BroadcastChannel
 * 3. If no heartbeat for 3s, followers trigger re-election
 * 4. On re-election, lowest lockId wins
 * 5. Leader calls beforeunload to resign gracefully
 */
type TabRole = 'leader' | 'follower';
interface TabCoordinatorConfig {
    /** Called when this tab becomes leader */
    onBecomeLeader: () => void;
    /** Called when this tab becomes follower */
    onBecomeFollower: () => void;
    /** Called when another tab modifies IndexedDB */
    onRemoteStoreChange: (collection: string, docId: string) => void;
    /** Debug mode */
    debug: boolean;
}
/**
 * Coordinates multiple browser tabs via BroadcastChannel.
 */
declare class TabCoordinator {
    private channel;
    private readonly tabId;
    private readonly lockId;
    private readonly config;
    private role;
    private heartbeatInterval;
    private heartbeatTimeout;
    private destroyed;
    constructor(config: TabCoordinatorConfig);
    /**
     * Start the coordinator and participate in leader election.
     */
    start(): void;
    /**
     * Stop the coordinator.
     */
    stop(): void;
    /**
     * Current tab role.
     */
    get currentRole(): TabRole;
    /**
     * Whether this tab is the leader.
     */
    get isLeader(): boolean;
    /**
     * Broadcast a store change event to other tabs.
     * Called by the leader after writing to IndexedDB.
     */
    broadcastStoreChange(collection: string, docId: string): void;
    private claimLeadership;
    private becomeLeader;
    private becomeFollower;
    private handleMessage;
    private handleBeforeUnload;
    private startHeartbeat;
    private clearHeartbeat;
    private startHeartbeatTimeout;
    private resetHeartbeatTimeout;
    private clearHeartbeatTimeout;
    private broadcast;
    private log;
}

export { CollectionProxy, DebugManager, type MeridianClient, type MeridianClientConfig, MeridianStore, type PresenceCallback, type PresenceData, PresenceManager, type Query, type Subscriber, SyncEngine, TabCoordinator, type TabRole, type Unsubscribe, createClient };
