/**
 * Meridian — Storage Adapter Interface
 *
 * Abstract storage interface enabling multiple database backends.
 *
 * Currently implemented:
 * - PostgreSQL (via PgStore in @meridian-sync/server)
 *
 * V2 Roadmap:
 * - SQLite (Turso / libsql)
 * - MySQL
 */

import type { CRDTOperation, ServerChange } from './protocol.js';
import type { SchemaDefinition } from './schema.js';

// ─── Storage Adapter Interface ──────────────────────────────────────────────

export interface StorageAdapter {
  /** Initialize storage — create tables, indexes, etc. */
  init(): Promise<void>;

  /** Apply CRDT operations and return changes with sequence numbers */
  applyOperations(ops: CRDTOperation[]): Promise<{
    changes: ServerChange[];
    conflicts: ConflictInfo[];
  }>;

  /** Get all changes since a sequence number. Returns null if compaction gap. */
  getChangesSince(since: number): Promise<ServerChange[] | null>;

  /** Get the current minimum sequence number (for compaction tracking) */
  getMinSeq(): Promise<number>;

  /** Permanently delete tombstones older than the given age */
  compact(maxAgeMs: number): Promise<number>;

  /** Clean up and close connections */
  close(): Promise<void>;
}

export interface ConflictInfo {
  collection: string;
  docId: string;
  field: string;
  winnerValue: unknown;
  loserValue: unknown;
}

export interface StorageAdapterConfig {
  schema: SchemaDefinition;
  /** Called when data changes (for LISTEN/NOTIFY or similar) */
  onChange?: (collection: string, docId: string) => void;
  debug?: boolean;
}

// ─── PostgreSQL Adapter Config ──────────────────────────────────────────────

export interface PostgresAdapterConfig extends StorageAdapterConfig {
  connectionString: string;
}

// ─── SQLite Adapter Config ──────────────────────────────────────────────────

export interface SQLiteAdapterConfig extends StorageAdapterConfig {
  /** Path to SQLite database file, or ':memory:' for in-memory */
  databasePath: string;
}
