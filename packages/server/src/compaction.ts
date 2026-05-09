/**
 * Meridian Server — Tombstone Compaction
 *
 * Periodically removes soft-deleted rows older than a configurable max age.
 * After compaction, notifies connected clients so they can clean up local data.
 */

import type { PgStore } from './pg-store.js';
import type { WsHub } from './ws-hub.js';

export interface CompactionConfig {
  /** Maximum age for tombstones in ms (default: 30 days) */
  tombstoneMaxAge: number;
  /** Compaction check interval in ms (default: 24 hours) */
  interval: number;
  /** Debug mode */
  debug?: boolean;
}

const DEFAULT_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days
const DEFAULT_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Tombstone compaction scheduler.
 */
export class CompactionManager {
  private readonly pgStore: PgStore;
  private readonly wsHub: WsHub;
  private readonly config: CompactionConfig;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    pgStore: PgStore,
    wsHub: WsHub,
    config?: Partial<CompactionConfig>
  ) {
    this.pgStore = pgStore;
    this.wsHub = wsHub;
    this.config = {
      tombstoneMaxAge: config?.tombstoneMaxAge ?? DEFAULT_MAX_AGE,
      interval: config?.interval ?? DEFAULT_INTERVAL,
      debug: config?.debug ?? false,
    };
  }

  /**
   * Start the compaction scheduler.
   */
  start(): void {
    this.log(`🧹 Compaction scheduler started (interval: ${this.config.interval}ms, maxAge: ${this.config.tombstoneMaxAge}ms)`);

    // Run initial compaction after a short delay
    setTimeout(() => this.runCompaction(), 5000);

    this.timer = setInterval(() => this.runCompaction(), this.config.interval);
  }

  /**
   * Stop the compaction scheduler.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run compaction now.
   */
  async runCompaction(): Promise<number> {
    this.log('🧹 Running compaction...');

    try {
      const deleted = await this.pgStore.compact(this.config.tombstoneMaxAge);
      const minSeq = this.pgStore.getMinSeq();

      if (deleted > 0) {
        this.log(`🧹 Compacted ${deleted} tombstones. New minSeq: ${minSeq}`);

        // Notify all connected clients
        this.wsHub.broadcastToAll({
          type: 'compaction',
          minSeq,
        });
      } else {
        this.log('🧹 No tombstones to compact');
      }

      return deleted;
    } catch (e) {
      this.log('❌ Compaction failed:', e);
      return 0;
    }
  }

  private log(...args: unknown[]): void {
    if (this.config.debug) {
      console.log('[Meridian Compaction]', ...args);
    }
  }
}
