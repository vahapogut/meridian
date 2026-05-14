/**
 * Meridian — SQLite Storage Adapter
 *
 * Implements StorageAdapter for SQLite databases.
 * Supports:
 * - better-sqlite3 (Node.js server)
 * - sql.js (WASM — browser/React Native)
 * - Turso/libsql (edge/distributed SQLite)
 *
 * Usage:
 * ```ts
 * const store = new SQLiteStore({
 *   databasePath: './meridian.db',
 *   schema,
 * });
 * await store.init();
 * ```
 */

import type {
  CRDTOperation,
  ServerChange,
  ConflictRecord,
  SchemaDefinition,
  CollectionSchema,
} from '@meridian-sync/shared';
import {
  createLWWMap,
  mergeLWWMaps,
  extractValues,
  extractMetadata,
  isDeleted,
  DELETED_FIELD,
  fieldTypeToSQL,
  getDefaults,
} from '@meridian-sync/shared';
import type { StorageAdapterConfig, ConflictInfo } from '@meridian-sync/shared';

// ─── Driver Interface ────────────────────────────────────────────────────────

/**
 * Minimal SQL driver interface — compatible with better-sqlite3, sql.js, and libsql.
 */
export interface SQLDriver {
  exec(sql: string): void;
  prepare(sql: string): SQLStatement;
  close(): void;
}

export interface SQLStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

// ─── Config ──────────────────────────────────────────────────────────────────

export interface SQLiteStoreConfig extends StorageAdapterConfig {
  /** SQL driver instance (better-sqlite3 Database, sql.js Database, etc.) */
  driver: SQLDriver;
}

// ─── SQLite Store ────────────────────────────────────────────────────────────

export class SQLiteStore {
  private readonly driver: SQLDriver;
  private readonly config: SQLiteStoreConfig;
  private lastSeq = 0;
  private minSeq = 0;

  constructor(config: SQLiteStoreConfig) {
    this.driver = config.driver;
    this.config = config;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    const { schema } = this.config;

    // Create sync metadata table
    this.driver.exec(`
      CREATE TABLE IF NOT EXISTS _meridian_sync (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    // Create tables for each collection
    for (const [name, colSchema] of Object.entries(schema.collections)) {
      this.createTable(name, colSchema);
    }

    // Load last seq
    const row = this.driver
      .prepare("SELECT value FROM _meridian_sync WHERE key = 'last_seq'")
      .get() as { value: string } | undefined;
    this.lastSeq = row ? parseInt(row.value, 10) : 0;

    if (this.config.debug) {
      console.log(`[SQLite Store] Initialized. Last seq: ${this.lastSeq}`);
    }
  }

  private createTable(name: string, schema: CollectionSchema): void {
    const columns: string[] = ['id TEXT PRIMARY KEY'];

    for (const [field, def] of Object.entries(schema)) {
      if (field === 'id') continue;
      const sqlType = fieldTypeToSQL(def.type);
      const defaultClause = def.defaultValue !== undefined
        ? ` DEFAULT ${JSON.stringify(def.defaultValue)}`
        : '';
      columns.push(`"${field}" ${sqlType}${defaultClause}`);
    }

    // Meridian system columns
    columns.push('_meridian_meta TEXT');       // JSON-serialized CRDT metadata
    columns.push('_meridian_seq INTEGER');      // Monotonic sequence number
    columns.push('_meridian_deleted INTEGER DEFAULT 0'); // Tombstone flag
    columns.push('_meridian_updated_at TEXT');  // ISO timestamp

    this.driver.exec(`CREATE TABLE IF NOT EXISTS "${name}" (${columns.join(', ')})`);
    this.driver.exec(`CREATE INDEX IF NOT EXISTS idx_${name}_seq ON "${name}" (_meridian_seq)`);
  }

  // ─── CRUD ──────────────────────────────────────────────────────────────────

  async applyOperations(ops: CRDTOperation[]): Promise<{
    changes: ServerChange[];
    conflicts: ConflictInfo[];
  }> {
    const changes: ServerChange[] = [];
    const conflicts: ConflictInfo[] = [];

    // Group by collection:docId
    const grouped = new Map<string, CRDTOperation[]>();
    for (const op of ops) {
      const key = `${op.collection}:${op.docId}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(op);
    }

    for (const [key, docOps] of grouped) {
      const [collection, docId] = key.split(':');

      // Read existing
      const existing = this.driver
        .prepare(`SELECT * FROM "${collection}" WHERE id = ?`)
        .get(docId) as Record<string, unknown> | undefined;

      const existingMeta = existing?._meridian_meta
        ? JSON.parse(existing._meridian_meta as string)
        : null;

      // Build remote CRDT map
      const remoteMap: Record<string, { value: unknown; hlc: string; nodeId: string }> = {};
      for (const op of docOps) {
        remoteMap[op.field] = { value: op.value, hlc: op.hlc, nodeId: op.nodeId };
      }

      // Merge with existing
      let finalMap: Record<string, { value: unknown; hlc: string; nodeId: string }>;
      if (existingMeta) {
        const { merged, conflicts: fieldConflicts } = mergeLWWMaps(existingMeta, remoteMap);
        finalMap = merged;
        for (const c of fieldConflicts) {
          conflicts.push({ collection, docId, ...c });
        }
      } else {
        finalMap = remoteMap;
        finalMap[DELETED_FIELD] = { value: false, hlc: docOps[0].hlc, nodeId: docOps[0].nodeId };
      }

      // Write
      if (isDeleted(finalMap)) {
        this.driver
          .prepare(`DELETE FROM "${collection}" WHERE id = ?`)
          .run(docId);
      } else {
        const values = extractValues(finalMap);
        const defaults = getDefaults(this.config.schema.collections[collection]);
        for (const [field, defaultVal] of Object.entries(defaults)) {
          if (!(field in values)) (values as any)[field] = defaultVal;
        }

        const meta = JSON.stringify(extractMetadata(finalMap));
        this.lastSeq++;
        const now = new Date().toISOString();

        if (existing) {
          const setClauses: string[] = [];
          const params: unknown[] = [];
          for (const [field, value] of Object.entries(values)) {
            setClauses.push(`"${field}" = ?`);
            params.push(value);
          }
          setClauses.push('_meridian_meta = ?'); params.push(meta);
          setClauses.push('_meridian_seq = ?'); params.push(this.lastSeq);
          setClauses.push('_meridian_updated_at = ?'); params.push(now);

          this.driver
            .prepare(`UPDATE "${collection}" SET ${setClauses.join(', ')} WHERE id = ?`)
            .run(...params, docId);
        } else {
          const fields = Object.keys(values);
          const placeholders = fields.map(() => '?').join(', ');
          const params: unknown[] = fields.map(f => values[f]);
          params.push(meta, this.lastSeq, 0, now);

          this.driver
            .prepare(`INSERT INTO "${collection}" (${fields.map(f => `"${f}"`).join(', ')}, _meridian_meta, _meridian_seq, _meridian_deleted, _meridian_updated_at) VALUES (${placeholders}, ?, ?, 0, ?)`)
            .run(...params);
        }
      }

      // Emit changes
      for (const op of docOps) {
        changes.push({ seq: this.lastSeq, op });
      }
    }

    // Save last seq
    this.driver
      .prepare("INSERT OR REPLACE INTO _meridian_sync (key, value) VALUES ('last_seq', ?)")
      .run(this.lastSeq.toString());

    return { changes, conflicts };
  }

  async getChangesSince(since: number): Promise<ServerChange[] | null> {
    if (since < this.minSeq) return null; // Compaction gap

    const changes: ServerChange[] = [];
    for (const name of Object.keys(this.config.schema.collections)) {
      const rows = this.driver
        .prepare(`SELECT * FROM "${name}" WHERE _meridian_seq > ?`)
        .all(since) as Record<string, unknown>[];

      for (const row of rows) {
        const meta = row._meridian_meta ? JSON.parse(row._meridian_meta as string) : {};
        for (const [field, hlcStr] of Object.entries(meta)) {
          changes.push({
            seq: row._meridian_seq as number,
            op: {
              id: `${row.id}-${field}-${hlcStr}`,
              collection: name,
              docId: row.id as string,
              field,
              value: row[field],
              hlc: hlcStr as string,
              nodeId: 'server',
            },
          });
        }
      }
    }

    return changes;
  }

  getMinSeq(): number {
    return this.minSeq;
  }

  async compact(maxAgeMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    let deleted = 0;

    for (const name of Object.keys(this.config.schema.collections)) {
      const result = this.driver
        .prepare(`DELETE FROM "${name}" WHERE _meridian_deleted = 1 AND _meridian_updated_at < ?`)
        .run(cutoff);
      deleted += result.changes;
    }

    this.minSeq = this.lastSeq;
    if (this.config.debug) {
      console.log(`[SQLite Store] Compaction: deleted ${deleted} tombstones`);
    }

    return deleted;
  }

  async close(): Promise<void> {
    this.driver.close();
  }
}
