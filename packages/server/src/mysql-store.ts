/**
 * Meridian — MySQL Storage Adapter
 *
 * Implements StorageAdapter for MySQL databases.
 * Uses mysql2 driver for Node.js.
 *
 * Usage:
 * ```ts
 * import mysql from 'mysql2/promise';
 * const pool = mysql.createPool('mysql://localhost/meridian');
 * const store = new MySQLStore({ pool, schema });
 * await store.init();
 * ```
 */

import type {
  CRDTOperation, ServerChange, ConflictRecord,
  SchemaDefinition, CollectionSchema,
} from '@meridian-sync/shared';
import {
  createLWWMap, mergeLWWMaps, extractValues,
  extractMetadata, isDeleted, DELETED_FIELD,
  fieldTypeToSQL, getDefaults,
} from '@meridian-sync/shared';
import type { ConflictInfo } from '@meridian-sync/shared';

// ─── Driver Interface ──────────────────────────────────────────────────────

export interface MySQLPool {
  execute(sql: string, params?: unknown[]): Promise<[ResultSetHeader, any]>;
  query(sql: string, params?: unknown[]): Promise<[RowDataPacket[], any]>;
  end(): Promise<void>;
}

interface ResultSetHeader { insertId: number; affectedRows: number; }
interface RowDataPacket { [key: string]: unknown; }

// ─── Config ────────────────────────────────────────────────────────────────

export interface MySQLStoreConfig {
  pool: MySQLPool;
  schema: SchemaDefinition;
  debug?: boolean;
}

function mysqlType(fieldType: string): string {
  switch (fieldType) {
    case 'string': return 'TEXT';
    case 'number': return 'DOUBLE';
    case 'boolean': return 'TINYINT(1)';
    case 'array': case 'object': return 'JSON';
    default: return 'TEXT';
  }
}

// ─── MySQL Store ────────────────────────────────────────────────────────────

export class MySQLStore {
  private pool: MySQLPool;
  private config: MySQLStoreConfig;
  private lastSeq = 0;
  private minSeq = 0;

  constructor(config: MySQLStoreConfig) {
    this.pool = config.pool;
    this.config = config;
  }

  async init(): Promise<void> {
    const { schema } = this.config;

    await this.pool.execute(`CREATE TABLE IF NOT EXISTS _meridian_sync (
      \`key\` VARCHAR(255) PRIMARY KEY,
      \`value\` TEXT NOT NULL
    ) ENGINE=InnoDB`);

    for (const [name, colSchema] of Object.entries(schema.collections)) {
      const columns = ['id VARCHAR(255) PRIMARY KEY'];
      for (const [field, def] of Object.entries(colSchema)) {
        if (field === 'id') continue;
        const sqlType = mysqlType(def.type);
        const defaultVal = def.defaultValue !== undefined
          ? ` DEFAULT ${JSON.stringify(def.defaultValue)}`
          : '';
        columns.push(`\`${field}\` ${sqlType}${defaultVal}`);
      }
      columns.push('_meridian_meta JSON');
      columns.push('_meridian_seq BIGINT');
      columns.push('_meridian_deleted TINYINT(1) DEFAULT 0');
      columns.push('_meridian_updated_at VARCHAR(30)');

      await this.pool.execute(
        `CREATE TABLE IF NOT EXISTS \`${name}\` (${columns.join(', ')}) ENGINE=InnoDB`
      );
      await this.pool.execute(
        `CREATE INDEX IF NOT EXISTS idx_${name}_seq ON \`${name}\` (_meridian_seq)`
      );
    }

    const [rows] = await this.pool.query(
      "SELECT value FROM _meridian_sync WHERE `key` = 'last_seq'"
    ) as [RowDataPacket[], any];
    this.lastSeq = rows.length > 0 ? parseInt(rows[0].value as string, 10) : 0;

    if (this.config.debug) {
      console.log(`[MySQL Store] Initialized. Last seq: ${this.lastSeq}`);
    }
  }

  async applyOperations(ops: CRDTOperation[]): Promise<{
    changes: ServerChange[]; conflicts: ConflictInfo[];
  }> {
    const changes: ServerChange[] = [];
    const conflicts: ConflictInfo[] = [];

    const grouped = new Map<string, CRDTOperation[]>();
    for (const op of ops) {
      const key = `${op.collection}:${op.docId}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(op);
    }

    for (const [key, docOps] of grouped) {
      const [collection, docId] = key.split(':');
      const [rows] = await this.pool.query(
        `SELECT * FROM \`${collection}\` WHERE id = ?`, [docId]
      ) as [RowDataPacket[], any];

      const existing = rows.length > 0 ? rows[0] : null;
      const existingMeta = existing?._meridian_meta
        ? JSON.parse(existing._meridian_meta as string) : null;

      const remoteMap: Record<string, { value: unknown; hlc: string; nodeId: string }> = {};
      for (const op of docOps) {
        remoteMap[op.field] = { value: op.value, hlc: op.hlc, nodeId: op.nodeId };
      }

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

      this.lastSeq++;
      const meta = JSON.stringify(extractMetadata(finalMap));
      const now = new Date().toISOString();

      if (isDeleted(finalMap)) {
        await this.pool.execute(`DELETE FROM \`${collection}\` WHERE id = ?`, [docId]);
      } else {
        const values = extractValues(finalMap);
        const defaults = getDefaults(this.config.schema.collections[collection]);
        for (const [field, defaultVal] of Object.entries(defaults)) {
          if (!(field in values)) (values as any)[field] = defaultVal;
        }

        if (existing) {
          const setClauses: string[] = [];
          const params: unknown[] = [];
          for (const [field, value] of Object.entries(values)) {
            setClauses.push(`\`${field}\` = ?`); params.push(value);
          }
          setClauses.push('_meridian_meta = ?'); params.push(meta);
          setClauses.push('_meridian_seq = ?'); params.push(this.lastSeq);
          setClauses.push('_meridian_updated_at = ?'); params.push(now);
          params.push(docId);
          await this.pool.execute(
            `UPDATE \`${collection}\` SET ${setClauses.join(', ')} WHERE id = ?`, params
          );
        } else {
          const fields = Object.keys(values).filter(f => f !== 'id');
          const allFields = [...fields, '_meridian_meta', '_meridian_seq', '_meridian_deleted', '_meridian_updated_at'];
          const placeholders = allFields.map(() => '?').join(', ');
          const params: unknown[] = [docId, ...fields.map(f => values[f]),
            meta, this.lastSeq, 0, now];
          await this.pool.execute(
            `INSERT INTO \`${collection}\` (id, ${fields.map(f => `\`${f}\``).join(', ')}, _meridian_meta, _meridian_seq, _meridian_deleted, _meridian_updated_at) VALUES (?, ${placeholders})`,
            params
          );
        }
      }

      for (const op of docOps) {
        changes.push({ seq: this.lastSeq, op });
      }
    }

    await this.pool.execute(
      "INSERT INTO _meridian_sync (`key`, value) VALUES ('last_seq', ?) ON DUPLICATE KEY UPDATE value = ?",
      [this.lastSeq.toString(), this.lastSeq.toString()]
    );
    return { changes, conflicts };
  }

  async getChangesSince(since: number): Promise<ServerChange[] | null> {
    if (since < this.minSeq) return null;
    const changes: ServerChange[] = [];

    for (const name of Object.keys(this.config.schema.collections)) {
      const [rows] = await this.pool.query(
        `SELECT * FROM \`${name}\` WHERE _meridian_seq > ?`, [since]
      ) as [RowDataPacket[], any];

      for (const row of rows) {
        const meta = row._meridian_meta ? JSON.parse(row._meridian_meta as string) : {};
        for (const [field, hlcStr] of Object.entries(meta)) {
          changes.push({
            seq: row._meridian_seq as number,
            op: {
              id: `${row.id}-${field}-${hlcStr}`,
              collection: name, docId: row.id as string,
              field, value: row[field],
              hlc: hlcStr as string, nodeId: 'server',
            },
          });
        }
      }
    }
    return changes;
  }

  getMinSeq(): number { return this.minSeq; }

  async compact(maxAgeMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    let deleted = 0;
    for (const name of Object.keys(this.config.schema.collections)) {
      const [result] = await this.pool.execute(
        `DELETE FROM \`${name}\` WHERE _meridian_deleted = 1 AND _meridian_updated_at < ?`,
        [cutoff]
      ) as [ResultSetHeader, any];
      deleted += result.affectedRows;
    }
    this.minSeq = this.lastSeq;
    return deleted;
  }

  async close(): Promise<void> { await this.pool.end(); }
}
