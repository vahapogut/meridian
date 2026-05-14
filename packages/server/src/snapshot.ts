/**
 * Meridian — Snapshot Recovery
 *
 * Optimizes full re-sync by creating periodic snapshots of collection state.
 * Instead of replaying all operations from seq=0, clients can load a snapshot
 * and only replay operations since the snapshot's sequence number.
 *
 * Benefits:
 * - New clients sync in O(snapshot + delta) instead of O(all_ops)
 * - Bandwidth reduction for clients that have been offline for days
 * - Faster recovery after compaction gaps
 */

import type { ServerChange, SchemaDefinition } from 'meridian-shared';
import type { MySQLPool } from './mysql-store.js';
import type { PgStore } from './pg-store.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Snapshot {
  /** Sequence number this snapshot was taken at */
  seq: number;
  /** ISO timestamp of snapshot creation */
  createdAt: string;
  /** Collection snapshots */
  collections: Record<string, CollectionSnapshot>;
}

export interface CollectionSnapshot {
  /** Collection name */
  name: string;
  /** Number of documents */
  count: number;
  /** All non-deleted documents */
  documents: Record<string, unknown>[];
}

export interface SnapshotConfig {
  /** Create a snapshot every N operations */
  interval: number;
  /** Maximum number of snapshots to keep */
  maxSnapshots: number;
  /** Database (pgStore or mysqlStore) */
  store: PgStore | { getChangesSince(since: number): Promise<ServerChange[] | null>; getMinSeq(): number };
  /** Schema definition */
  schema: SchemaDefinition;
  /** Debug logging */
  debug?: boolean;
}

// ─── Snapshot Manager ───────────────────────────────────────────────────────

export class SnapshotManager {
  private config: SnapshotConfig;
  private snapshots: Map<number, Snapshot> = new Map();
  private opCounter = 0;

  constructor(config: SnapshotConfig) {
    this.config = config;
  }

  /**
   * Track an operation. Creates a snapshot when the interval is reached.
   */
  async trackOp(): Promise<void> {
    this.opCounter++;
    if (this.opCounter >= this.config.interval) {
      await this.createSnapshot();
    }
  }

  /**
   * Create a snapshot of all collections at the current sequence number.
   */
  async createSnapshot(): Promise<Snapshot> {
    const changes = await this.config.store.getChangesSince(this.config.store.getMinSeq());
    const seq = changes ? Math.max(...changes.map(c => c.seq), this.config.store.getMinSeq()) : this.config.store.getMinSeq();

    const collections: Record<string, CollectionSnapshot> = {};

    for (const name of Object.keys(this.config.schema.collections)) {
      if (changes) {
        const docs = changes
          .filter(c => c.op.collection === name)
          .reduce((acc, c) => {
            if (!acc[c.op.docId]) acc[c.op.docId] = { id: c.op.docId };
            acc[c.op.docId][c.op.field] = c.op.value;
            return acc;
          }, {} as Record<string, Record<string, unknown>>);

        collections[name] = {
          name,
          count: Object.keys(docs).length,
          documents: Object.values(docs),
        };
      }
    }

    const snapshot: Snapshot = {
      seq,
      createdAt: new Date().toISOString(),
      collections,
    };

    this.snapshots.set(seq, snapshot);
    this.opCounter = 0;

    // Enforce max snapshots
    if (this.snapshots.size > this.config.maxSnapshots) {
      const oldest = Math.min(...this.snapshots.keys());
      this.snapshots.delete(oldest);
    }

    if (this.config.debug) {
      let totalDocs = 0;
      for (const c of Object.values(collections)) totalDocs += c.count;
      console.log(`[Snapshot] Created at seq=${seq}: ${totalDocs} docs across ${Object.keys(collections).length} collections`);
    }

    return snapshot;
  }

  /**
   * Get the most recent snapshot at or before the given sequence number.
   */
  getSnapshotForSeq(seq: number): Snapshot | null {
    let best: Snapshot | null = null;
    for (const [snapSeq, snap] of this.snapshots) {
      if (snapSeq <= seq && (!best || snapSeq > best.seq)) {
        best = snap;
      }
    }
    return best;
  }

  /**
   * Estimate bandwidth savings from using a snapshot vs full replay.
   *
   * @param totalOps - Total operations since seq 0
   * @param snapshotSeq - Sequence number of the snapshot
   * @returns Percentage of operations saved
   */
  estimateSavings(totalOps: number, snapshotSeq: number): number {
    return Math.round((1 - (totalOps / (snapshotSeq || 1))) * 100);
  }

  /**
   * Get all stored snapshots (for debugging/management).
   */
  getSnapshots(): Snapshot[] {
    return Array.from(this.snapshots.values())
      .sort((a, b) => b.seq - a.seq);
  }

  /**
   * Clear all snapshots (e.g., after schema change).
   */
  clear(): void {
    this.snapshots.clear();
    this.opCounter = 0;
  }
}
