/**
 * Meridian — WAL Streaming (PostgreSQL Logical Replication)
 *
 * Production-grade change streaming using PostgreSQL's
 * LISTEN/NOTIFY + logical replication protocol.
 *
 * Two modes:
 * 1. NOTIFY mode (default) — Fast, simple, uses pg_notify()
 *    triggers. Good for up to ~10K concurrent clients.
 * 2. WAL mode — Uses wal2json logical decoding plugin for
 *    massive scale (100K+ clients). Requires:
 *    - `wal_level = logical` in postgresql.conf
 *    - `CREATE EXTENSION wal2json;` (if not already installed)
 */

import { Client } from 'pg';
import type { CRDTOperation, ServerChange } from '@meridian-sync/shared';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WALStreamConfig {
  /** PostgreSQL connection string */
  connectionString: string;
  /** Mode: 'notify' (default) or 'wal' (logical replication) */
  mode?: 'notify' | 'wal';
  /** Channel name for NOTIFY mode */
  channel?: string;
  /** Publication name for WAL mode */
  publication?: string;
  /** Slot name for WAL mode */
  slot?: string;
  /** Called for each change received */
  onChange: (change: WALChange) => void;
  /** Debug logging */
  debug?: boolean;
}

export interface WALChange {
  collection: string;
  docId: string;
  operation: 'INSERT' | 'UPDATE' | 'DELETE';
  fields?: Record<string, unknown>;
  seq?: number;
}

// ─── NOTIFY Mode Stream ─────────────────────────────────────────────────────

/**
 * Stream changes using PostgreSQL LISTEN/NOTIFY.
 * Requires triggers on each table that call pg_notify().
 */
class NotifyStream {
  private client: Client;
  private config: WALStreamConfig;
  private connected = false;

  constructor(config: WALStreamConfig) {
    this.config = config;
    this.client = new Client({ connectionString: config.connectionString });
  }

  async start(): Promise<void> {
    await this.client.connect();
    this.connected = true;

    const channel = this.config.channel || 'meridian_changes';

    this.client.on('notification', (msg) => {
      try {
        const payload = JSON.parse(msg.payload || '{}');
        if (this.config.debug) {
          console.log(`[WAL-NOTIFY] ${channel}:`, payload.collection, payload.docId);
        }
        this.config.onChange({
          collection: payload.collection,
          docId: payload.docId,
          operation: payload.operation || 'UPDATE',
          fields: payload.fields,
          seq: payload.seq,
        });
      } catch (err) {
        console.error('[WAL-NOTIFY] Failed to parse notification:', err);
      }
    });

    await this.client.query(`LISTEN ${channel}`);
    if (this.config.debug) {
      console.log(`[WAL-NOTIFY] Listening on channel "${channel}"`);
    }

    // Create trigger function if it doesn't exist
    await this.createNotifyTriggers();
  }

  private async createNotifyTriggers(): Promise<void> {
    await this.client.query(`
      CREATE OR REPLACE FUNCTION meridian_notify() RETURNS trigger AS $$
      BEGIN
        PERFORM pg_notify(
          $1,
          json_build_object(
            'collection', TG_TABLE_NAME,
            'docId', NEW.id,
            'operation', TG_OP,
            'seq', NEW._meridian_seq
          )::text
        );
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `, [this.config.channel || 'meridian_changes']);
  }

  async stop(): Promise<void> {
    if (!this.connected) return;
    const channel = this.config.channel || 'meridian_changes';
    await this.client.query(`UNLISTEN ${channel}`);
    await this.client.end();
    this.connected = false;
  }
}

// ─── WAL Mode Stream (Logical Replication via polling) ─────────────────────

/**
 * Stream changes using PostgreSQL logical replication via pg_logical_slot_get_changes().
 * Polls the replication slot at configurable intervals.
 *
 * Requires wal_level = logical.
 * More scalable than NOTIFY for 100K+ concurrent changes/sec.
 */
class WALStream {
  private config: WALStreamConfig;
  private client: Client | null = null;
  private pollingInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: WALStreamConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    this.client = new Client({ connectionString: this.config.connectionString });
    await this.client.connect();

    const pubName = this.config.publication || 'meridian_pub';
    const slotName = this.config.slot || 'meridian_slot';

    // Ensure wal2json extension is available
    await this.client.query(`CREATE EXTENSION IF NOT EXISTS wal2json`);

    // Create publication for all tables
    await this.client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = '${pubName}') THEN
          CREATE PUBLICATION ${pubName} FOR ALL TABLES;
        END IF;
      END $$;
    `);

    // Create replication slot if not exists (uses wal2json for JSON output)
    const { rows: slotRows } = await this.client.query(
      `SELECT slot_name FROM pg_replication_slots WHERE slot_name = $1`,
      [slotName]
    );
    if (slotRows.length === 0) {
      // Requires: CREATE EXTENSION IF NOT EXISTS wal2json;
      await this.client.query(
        `SELECT pg_create_logical_replication_slot($1, 'wal2json')`,
        [slotName]
      );
    }

    // Poll for changes every 100ms
    const POLL_INTERVAL = 100;

    this.pollingInterval = setInterval(async () => {
      try {
        // pg_logical_slot_get_changes auto-advances the slot cursor —
        // each call returns only new changes since the last call.
        const { rows } = await this.client!.query(
          `SELECT data FROM pg_logical_slot_get_changes($1, NULL, NULL)`,
          [slotName]
        );

        for (const row of rows) {
          const parsed = this.parsePGOutput(row.data);
          if (parsed) {
            this.config.onChange({
              collection: parsed.collection,
              docId: parsed.docId,
              operation: parsed.operation,
              seq: parsed.seq,
            });
          }
        }
      } catch (err) {
        console.error('[WAL] Poll error:', err);
      }
    }, POLL_INTERVAL);

    if (this.config.debug) {
      console.log(`[WAL] Publication "${pubName}", slot "${slotName}", polling every ${POLL_INTERVAL}ms`);
    }
  }

  /** Parse wal2json JSON output into a WALChange */
  private parsePGOutput(data: string): { collection: string; docId: string; operation: 'INSERT' | 'UPDATE' | 'DELETE'; seq?: number } | null {
    try {
      // wal2json format: { "change": [{ "kind": "insert"|"update"|"delete", "table": "...", ... }] }
      const parsed = JSON.parse(data);
      if (!parsed.change || parsed.change.length === 0) return null;

      const change = parsed.change[0];
      const table = change.table;
      const kind = change.kind as string;

      // Extract docId: first column value (typically 'id') from columnvalues or oldkeys
      let docId: string | undefined;
      if (change.columnvalues && change.columnnames) {
        const idIndex = change.columnnames.indexOf('id');
        docId = idIndex >= 0 ? String(change.columnvalues[idIndex]) : String(change.columnvalues[0]);
      } else if (change.oldkeys?.keyvalues) {
        const idIndex = change.oldkeys.keynames.indexOf('id');
        docId = idIndex >= 0 ? String(change.oldkeys.keyvalues[idIndex]) : String(change.oldkeys.keyvalues[0]);
      }

      if (!docId || !table) return null;

      const operation = kind === 'delete' ? 'DELETE' : kind === 'update' ? 'UPDATE' : 'INSERT';

      // Extract seq from _meridian_seq if present
      let seq: number | undefined;
      if (change.columnnames && change.columnvalues) {
        const seqIndex = change.columnnames.indexOf('_meridian_seq');
        if (seqIndex >= 0) seq = parseInt(change.columnvalues[seqIndex], 10);
      }

      return { collection: table, docId, operation, seq };
    } catch {
      return null;
    }
  }

  async stop(): Promise<void> {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    if (this.client) {
      await this.client.end();
      this.client = null;
    }
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a WAL stream based on the configured mode.
 *
 * ```ts
 * const stream = createWALStream({
 *   connectionString: process.env.DATABASE_URL!,
 *   mode: 'notify', // or 'wal'
 *   onChange: (change) => {
 *     // Broadcast to WebSocket clients
 *     wsHub.broadcastToCollection(change.collection, change);
 *   },
 *   debug: true,
 * });
 * await stream.start();
 * ```
 */
export function createWALStream(config: WALStreamConfig): { start(): Promise<void>; stop(): Promise<void> } {
  const mode = config.mode || 'notify';
  if (mode === 'wal') {
    return new WALStream(config);
  }
  return new NotifyStream(config);
}
