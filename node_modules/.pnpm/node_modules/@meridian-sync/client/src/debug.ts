/**
 * Meridian Client — Debug Mode
 *
 * Provides visibility into sync state for development:
 * - Pending operations queue
 * - Conflict history
 * - Connection state
 * - Last sync time
 */

import type { PendingOp, ConnectionState, ConflictRecord } from '@meridian-sync/shared';
import type { MeridianStore } from './store.js';

/**
 * Debug interface exposed as `db.debug` when debug mode is enabled.
 */
export class DebugManager {
  private readonly store: MeridianStore;
  private conflictHistory: ConflictRecord[] = [];
  private connectionState: ConnectionState = 'disconnected';
  private lastSyncTime: number | null = null;
  private readonly maxConflictHistory = 100;

  constructor(store: MeridianStore) {
    this.store = store;
  }

  /**
   * Get all pending operations (not yet confirmed by server).
   */
  async getPendingOps(): Promise<PendingOp[]> {
    return this.store.getPendingOps();
  }

  /**
   * Get the last known server sequence number.
   */
  async getLastSyncSeq(): Promise<number> {
    return this.store.getLastSeq();
  }

  /**
   * Get the conflict history (limited to last 100 entries).
   */
  getConflictHistory(): ConflictRecord[] {
    return [...this.conflictHistory];
  }

  /**
   * Get the current connection state.
   */
  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  /**
   * Get the timestamp of the last successful sync.
   */
  getLastSyncTime(): number | null {
    return this.lastSyncTime;
  }

  // ─── Internal Updates ──────────────────────────────────────────────────────

  /** @internal */
  addConflict(conflict: ConflictRecord): void {
    this.conflictHistory.push(conflict);
    if (this.conflictHistory.length > this.maxConflictHistory) {
      this.conflictHistory.shift();
    }
  }

  /** @internal */
  updateConnectionState(state: ConnectionState): void {
    this.connectionState = state;
  }

  /** @internal */
  markSynced(): void {
    this.lastSyncTime = Date.now();
  }
}
