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

import pg from 'pg';
import {
  type SchemaDefinition,
  type CollectionSchema,
  type CRDTOperation,
  type LWWMap,
  type ServerChange,
  fieldTypeToSQL,
  reconstructLWWMap,
  mergeLWWMaps,
  extractValues,
  extractMetadata,
  getLatestHLC,
  isDeleted,
  DELETED_FIELD,
} from '@meridian-sync/shared';

const { Pool } = pg;

export interface PgStoreConfig {
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
export class PgStore {
  private pool: pg.Pool;
  private readonly config: PgStoreConfig;
  private changeCallbacks: Set<(tableName: string, docId: string) => void> = new Set();
  private listenClient: pg.PoolClient | null = null;
  private minSeq: number = 0;

  constructor(config: PgStoreConfig) {
    this.config = config;
    this.pool = new Pool({ connectionString: config.connectionString });
  }

  /**
   * Initialize the database — create tables, sequences, triggers.
   */
  async init(): Promise<void> {
    // Create the global sequence if not exists
    await this.pool.query(`
      CREATE SEQUENCE IF NOT EXISTS meridian_seq;
    `);

    // Create tables for each collection
    for (const [name, fields] of Object.entries(this.config.schema.collections)) {
      await this.createTable(name, fields);
    }

    // Start listening for changes
    await this.startListening();

    // Get initial minSeq
    await this.updateMinSeq();
  }

  /**
   * Get the table name with optional namespace prefix.
   */
  private tableName(collection: string): string {
    return this.config.namespace
      ? `${this.config.namespace}_${collection}`
      : collection;
  }

  /**
   * Create a table for a collection with Meridian system columns.
   */
  private async createTable(collection: string, fields: CollectionSchema): Promise<void> {
    const table = this.tableName(collection);

    // 1. Check if table exists
    const tableExistsResult = await this.pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = $1
      );
    `, [table]);

    const tableExists = tableExistsResult.rows[0].exists;

    if (!tableExists) {
      // Build column definitions
      const columns: string[] = ['id TEXT PRIMARY KEY'];

      for (const [name, def] of Object.entries(fields)) {
        if (name === 'id') continue;
        const sqlType = fieldTypeToSQL(def.type);
        columns.push(`${name} ${sqlType}`);
      }

      // Add Meridian system columns
      columns.push(`_meridian_meta JSONB DEFAULT '{}'::jsonb`);
      columns.push(`_meridian_seq BIGINT DEFAULT nextval('meridian_seq')`);
      columns.push(`_meridian_deleted BOOLEAN DEFAULT false`);
      columns.push(`_meridian_updated_at TEXT`);

      await this.pool.query(`
        CREATE TABLE ${table} (
          ${columns.join(',\n          ')}
        );
      `);

      // Create index on seq for efficient pull queries
      await this.pool.query(`
        CREATE INDEX idx_${table}_seq ON ${table}(_meridian_seq);
      `);
    } else {
      // 2. Additive Migrations: check for missing columns
      const colsResult = await this.pool.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = $1
      `, [table]);

      const existingColumns = new Set(colsResult.rows.map(r => r.column_name));

      for (const [name, def] of Object.entries(fields)) {
        if (name === 'id' || existingColumns.has(name)) continue;
        
        // Add missing column
        const sqlType = fieldTypeToSQL(def.type);
        await this.pool.query(`
          ALTER TABLE ${table} ADD COLUMN ${name} ${sqlType};
        `);
      }
    }

    // Create NOTIFY trigger
    await this.pool.query(`
      CREATE OR REPLACE FUNCTION meridian_notify_${table}() RETURNS trigger AS $$
      BEGIN
        PERFORM pg_notify('meridian_changes', json_build_object(
          'table', '${collection}',
          'id', NEW.id,
          'op', TG_OP
        )::text);
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await this.pool.query(`
      DROP TRIGGER IF EXISTS meridian_trigger_${table} ON ${table};
      CREATE TRIGGER meridian_trigger_${table}
        AFTER INSERT OR UPDATE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION meridian_notify_${table}();
    `);
  }

  // ─── CRDT Operations ───────────────────────────────────────────────────────

  /**
   * Apply CRDT operations from a client.
   * Performs field-level LWW merge with existing data.
   *
   * @returns Array of server changes with assigned sequence numbers
   */
  async applyOperations(ops: CRDTOperation[]): Promise<ServerChange[]> {
    const client = await this.pool.connect();
    const changes: ServerChange[] = [];

    try {
      await client.query('BEGIN');

      // Group ops by collection:docId
      const grouped = new Map<string, CRDTOperation[]>();
      for (const op of ops) {
        const key = `${op.collection}:${op.docId}`;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key)!.push(op);
      }

      for (const [key, docOps] of grouped) {
        const firstColon = key.indexOf(':');
        const collection = key.slice(0, firstColon);
        const docId = key.slice(firstColon + 1);
        const table = this.tableName(collection);

        // Get existing row
        const existing = await client.query(
          `SELECT * FROM ${table} WHERE id = $1 FOR UPDATE`,
          [docId]
        );

        // Build remote LWW-Map from incoming ops
        const remoteMap: LWWMap = {};
        for (const op of docOps) {
          remoteMap[op.field] = {
            value: op.value,
            hlc: op.hlc,
            nodeId: op.nodeId,
          };
        }

        let finalMap: LWWMap;

        if (existing.rows.length > 0) {
          const row = existing.rows[0];
          const existingMeta = row._meridian_meta || {};

          // Reconstruct existing LWW-Map
          const existingMap = reconstructLWWMap(row, existingMeta);

          // Merge
          const { merged } = mergeLWWMaps(existingMap, remoteMap);
          finalMap = merged;
        } else {
          finalMap = remoteMap;
        }

        // Extract values and metadata
        const values = extractValues(finalMap);
        const metadata = extractMetadata(finalMap);
        const latestHlc = getLatestHLC(finalMap);
        const deleted = isDeleted(finalMap);

        // Build upsert query
        const fields = Object.keys(this.config.schema.collections[collection] || {})
          .filter(f => f !== 'id');

        if (existing.rows.length > 0) {
          // UPDATE
          const setClauses: string[] = [];
          const params: unknown[] = [];
          let paramIdx = 1;

          for (const field of fields) {
            if (field in values) {
              setClauses.push(`${field} = $${paramIdx}`);
              params.push(values[field]);
              paramIdx++;
            }
          }

          setClauses.push(`_meridian_meta = $${paramIdx}`);
          params.push(JSON.stringify(metadata));
          paramIdx++;

          setClauses.push(`_meridian_deleted = $${paramIdx}`);
          params.push(deleted);
          paramIdx++;

          setClauses.push(`_meridian_updated_at = $${paramIdx}`);
          params.push(latestHlc);
          paramIdx++;

          setClauses.push(`_meridian_seq = nextval('meridian_seq')`);

          params.push(docId);

          const result = await client.query(
            `UPDATE ${table} SET ${setClauses.join(', ')} WHERE id = $${paramIdx} RETURNING _meridian_seq`,
            params
          );

          const seq = Number(result.rows[0]._meridian_seq);

          for (const op of docOps) {
            changes.push({ seq, op });
          }
        } else {
          // INSERT
          const insertFields = ['id'];
          const insertValues: unknown[] = [docId];
          const placeholders = ['$1'];
          let paramIdx = 2;

          for (const field of fields) {
            if (field in values) {
              insertFields.push(field);
              insertValues.push(values[field]);
              placeholders.push(`$${paramIdx}`);
              paramIdx++;
            }
          }

          insertFields.push('_meridian_meta');
          insertValues.push(JSON.stringify(metadata));
          placeholders.push(`$${paramIdx}`);
          paramIdx++;

          insertFields.push('_meridian_deleted');
          insertValues.push(deleted);
          placeholders.push(`$${paramIdx}`);
          paramIdx++;

          insertFields.push('_meridian_updated_at');
          insertValues.push(latestHlc);
          placeholders.push(`$${paramIdx}`);

          const result = await client.query(
            `INSERT INTO ${table} (${insertFields.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING _meridian_seq`,
            insertValues
          );

          const seq = Number(result.rows[0]._meridian_seq);

          for (const op of docOps) {
            changes.push({ seq, op });
          }
        }
      }

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    return changes;
  }

  /**
   * Get all changes since a given sequence number.
   * Used for pull protocol.
   *
   * @returns null if seqNum is below minSeq (compaction gap), otherwise changes
   */
  async getChangesSince(since: number): Promise<ServerChange[] | null> {
    // Check for compaction gap
    if (since > 0 && since < this.minSeq) {
      return null; // Caller should trigger full-sync-required
    }

    const changes: ServerChange[] = [];

    for (const collection of Object.keys(this.config.schema.collections)) {
      const table = this.tableName(collection);
      const fields = Object.keys(this.config.schema.collections[collection])
        .filter(f => f !== 'id');

      const result = await this.pool.query(
        `SELECT * FROM ${table} WHERE _meridian_seq > $1 ORDER BY _meridian_seq ASC`,
        [since]
      );

      for (const row of result.rows) {
        const meta = row._meridian_meta || {};
        const seq = Number(row._meridian_seq);

        for (const field of fields) {
          if (field in row && row[field] !== undefined) {
            const hlc = meta[field] || `0-0000-server`;
            changes.push({
              seq,
              op: {
                id: `${row.id}-${field}-${hlc}`,
                collection,
                docId: row.id,
                field,
                value: row[field],
                hlc,
                nodeId: 'server',
              },
            });
          }
        }

        // Include __deleted status
        if (row._meridian_deleted) {
          const hlc = meta[DELETED_FIELD] || `0-0000-server`;
          changes.push({
            seq,
            op: {
              id: `${row.id}-${DELETED_FIELD}-${hlc}`,
              collection,
              docId: row.id,
              field: DELETED_FIELD,
              value: true,
              hlc,
              nodeId: 'server',
            },
          });
        }
      }
    }

    // Sort by seq
    changes.sort((a, b) => a.seq - b.seq);

    return changes;
  }

  /**
   * Get the current minimum available sequence number.
   */
  getMinSeq(): number {
    return this.minSeq;
  }

  // ─── Compaction ─────────────────────────────────────────────────────────────

  /**
   * Delete tombstoned rows older than maxAge.
   * @returns Number of rows deleted
   */
  async compact(maxAgeMs: number): Promise<number> {
    let totalDeleted = 0;
    const cutoffTime = Date.now() - maxAgeMs;

    for (const collection of Object.keys(this.config.schema.collections)) {
      const table = this.tableName(collection);

      // Delete rows where _meridian_deleted = true AND updated before cutoff
      // We use the wallTime part of the HLC in _meridian_updated_at
      const result = await this.pool.query(
        `DELETE FROM ${table} WHERE _meridian_deleted = true AND 
         CAST(SPLIT_PART(_meridian_updated_at, '-', 1) AS BIGINT) < $1`,
        [cutoffTime]
      );

      totalDeleted += result.rowCount ?? 0;
    }

    // Update minSeq
    await this.updateMinSeq();

    return totalDeleted;
  }

  private async updateMinSeq(): Promise<void> {
    let minSeq = Infinity;

    for (const collection of Object.keys(this.config.schema.collections)) {
      const table = this.tableName(collection);

      try {
        const result = await this.pool.query(
          `SELECT MIN(_meridian_seq) as min_seq FROM ${table}`
        );

        if (result.rows[0]?.min_seq !== null) {
          minSeq = Math.min(minSeq, Number(result.rows[0].min_seq));
        }
      } catch {
        // Table might not exist yet
      }
    }

    this.minSeq = minSeq === Infinity ? 0 : minSeq;
  }

  // ─── LISTEN/NOTIFY ──────────────────────────────────────────────────────────

  private async startListening(): Promise<void> {
    this.listenClient = await this.pool.connect();

    this.listenClient.on('notification', (msg) => {
      if (msg.channel === 'meridian_changes' && msg.payload) {
        try {
          const data = JSON.parse(msg.payload);
          for (const cb of this.changeCallbacks) {
            cb(data.table, data.id);
          }
        } catch (e) {
          console.error('[Meridian PgStore] Failed to parse notification:', e);
        }
      }
    });

    await this.listenClient.query('LISTEN meridian_changes');
  }

  /**
   * Register a callback for database changes.
   */
  onChange(callback: (tableName: string, docId: string) => void): () => void {
    this.changeCallbacks.add(callback);
    return () => this.changeCallbacks.delete(callback);
  }

  // ─── Cleanup ───────────────────────────────────────────────────────────────

  /**
   * Close the database connection pool.
   */
  async close(): Promise<void> {
    if (this.listenClient) {
      this.listenClient.release();
      this.listenClient = null;
    }
    await this.pool.end();
  }
}
