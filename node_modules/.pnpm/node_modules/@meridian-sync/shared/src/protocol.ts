/**
 * Meridian — Sync Protocol Types
 *
 * Defines all WebSocket message types exchanged between client and server.
 * Uses a discriminated union pattern for type-safe message handling.
 */

// ─── CRDT Operation ──────────────────────────────────────────────────────────

/**
 * A single CRDT operation — the atomic unit of synchronization.
 * Represents a field-level write to a document in a collection.
 */
export interface CRDTOperation {
  /** Unique operation ID (UUID) */
  id: string;
  /** Collection name (e.g., "todos", "users") */
  collection: string;
  /** Document/row ID within the collection */
  docId: string;
  /** Field name being updated */
  field: string;
  /** New value (must be JSON-serializable) */
  value: unknown;
  /** HLC timestamp string of this operation */
  hlc: string;
  /** Node ID that generated this operation */
  nodeId: string;
}

/**
 * A server-enriched change — operation + server-assigned sequence number.
 * The seqNum is monotonically increasing and used for reliable pull cursors.
 */
export interface ServerChange {
  /** Server-assigned monotonic sequence number */
  seq: number;
  /** The underlying CRDT operation */
  op: CRDTOperation;
}

// ─── Client → Server Messages ────────────────────────────────────────────────

/** Push local changes to the server */
export interface PushMessage {
  type: 'push';
  ops: CRDTOperation[];
}

/** Pull changes since a server sequence number */
export interface PullMessage {
  type: 'pull';
  /** Server sequence number — only changes with seq > since are returned */
  since: number;
}

/** Subscribe to real-time changes for specific collections */
export interface SubscribeMessage {
  type: 'subscribe';
  collections: string[];
}

/** Send/update ephemeral presence data */
export interface PresenceSetMessage {
  type: 'presence';
  data: Record<string, unknown>;
}

/** Authenticate or refresh auth token */
export interface AuthMessage {
  type: 'auth';
  token: string;
  /** Client schema version for compatibility checking */
  schemaVersion?: number;
}

export type ClientMessage =
  | PushMessage
  | PullMessage
  | SubscribeMessage
  | PresenceSetMessage
  | AuthMessage;

// ─── Server → Client Messages ────────────────────────────────────────────────

/** Changes from server (pull response or real-time broadcast) */
export interface ChangesMessage {
  type: 'changes';
  changes: ServerChange[];
}

/** Acknowledgment of pushed operations */
export interface AckMessage {
  type: 'ack';
  /** The last server sequence number assigned to pushed ops */
  lastSeq: number;
  /** IDs of acknowledged operations */
  opIds: string[];
}

/** Rejection of a specific operation */
export interface RejectMessage {
  type: 'reject';
  /** The rejected operation ID */
  opId: string;
  /** Structured error code */
  code: RejectCode;
  /** Human-readable reason */
  reason: string;
}

/** Presence updates from connected peers */
export interface PresenceBroadcastMessage {
  type: 'presence';
  peers: Record<string, Record<string, unknown>>;
}

/** Compaction notification — tombstones before this seqNum were purged */
export interface CompactionMessage {
  type: 'compaction';
  /** Minimum available sequence number after compaction */
  minSeq: number;
}

/** Full re-sync required (e.g., after compaction gap or schema change) */
export interface FullSyncRequiredMessage {
  type: 'full-sync-required';
  reason: 'compaction' | 'schema-change';
  minSeq: number;
}

/** Auth token is about to expire */
export interface AuthExpiringMessage {
  type: 'auth-expiring';
  /** Seconds until token expires */
  expiresIn: number;
}

/** Auth token has expired — connection will close */
export interface AuthExpiredMessage {
  type: 'auth-expired';
}

/** General error */
export interface ErrorMessage {
  type: 'error';
  code: string;
  message: string;
}

export type ServerMessage =
  | ChangesMessage
  | AckMessage
  | RejectMessage
  | PresenceBroadcastMessage
  | CompactionMessage
  | FullSyncRequiredMessage
  | AuthExpiringMessage
  | AuthExpiredMessage
  | ErrorMessage;

// ─── Error Codes ─────────────────────────────────────────────────────────────

export type RejectCode =
  | 'VALIDATION'
  | 'AUTH'
  | 'SCHEMA_MISMATCH'
  | 'CONFLICT'
  | 'RATE_LIMIT';

// ─── Connection State ────────────────────────────────────────────────────────

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'authenticating'
  | 'connected'
  | 'syncing'
  | 'error';

// ─── Internal Types ──────────────────────────────────────────────────────────

/** Pending operation stored in IndexedDB until acknowledged by server */
export interface PendingOp {
  /** Operation ID */
  id: string;
  /** The CRDT operation */
  op: CRDTOperation;
  /** Previous value of the field (for rollback) */
  previousValue: unknown;
  /** Previous HLC of the field (for rollback) */
  previousHlc: string | null;
  /** Status */
  status: 'pending' | 'sending' | 'acked' | 'rejected';
  /** Timestamp when the operation was created */
  createdAt: number;
  /** Number of send attempts */
  retries: number;
}

/** Tab coordination messages via BroadcastChannel */
export type TabMessage =
  | { type: 'leader-resign'; tabId: string }
  | { type: 'claim-leader'; tabId: string; lockId: number }
  | { type: 'leader-ack'; tabId: string }
  | { type: 'leader-heartbeat'; tabId: string }
  | { type: 'store-changed'; collection: string; docId: string }
  | { type: 'request-sync' };
