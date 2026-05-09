/**
 * Meridian Client — Presence API
 *
 * Ephemeral presence data (cursors, status, etc.) that is:
 * - NOT persisted to IndexedDB
 * - Transmitted via WebSocket only
 * - Auto-re-sent on reconnect
 * - Cleaned up on disconnect (5s timeout server-side)
 */

export type PresenceData = Record<string, unknown>;
export type PresenceCallback = (peers: Record<string, PresenceData>) => void;

/**
 * Client-side presence manager.
 */
export class PresenceManager {
  private localPresence: PresenceData | null = null;
  private peers: Record<string, PresenceData> = {};
  private listeners: Set<PresenceCallback> = new Set();
  private sendFn: ((data: PresenceData) => void) | null = null;

  /**
   * Set the function used to send presence over WebSocket.
   */
  setSendFunction(fn: (data: PresenceData) => void): void {
    this.sendFn = fn;
  }

  /**
   * Set local presence data and broadcast to peers.
   *
   * Usage:
   * ```ts
   * db.presence.set({ cursor: { x: 100, y: 200 }, name: 'Alice' });
   * ```
   */
  set(data: PresenceData): void {
    this.localPresence = data;
    this.sendFn?.(data);
  }

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
  subscribe(callback: PresenceCallback): () => void {
    this.listeners.add(callback);

    // Immediately fire with current peers
    callback({ ...this.peers });

    return () => {
      this.listeners.delete(callback);
    };
  }

  /**
   * Handle presence broadcast from server.
   * Called by the sync engine when a presence message arrives.
   */
  handleServerPresence(peers: Record<string, PresenceData>): void {
    this.peers = peers;
    this.notifyListeners();
  }

  /**
   * Re-send local presence after reconnect.
   * Called by the sync engine when WebSocket reconnects.
   */
  resendPresence(): void {
    if (this.localPresence) {
      this.sendFn?.(this.localPresence);
    }
  }

  /**
   * Clear all presence data.
   */
  clear(): void {
    this.localPresence = null;
    this.peers = {};
    this.listeners.clear();
    this.sendFn = null;
  }

  private notifyListeners(): void {
    const snapshot = { ...this.peers };
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (e) {
        console.error('[Meridian Presence] Listener error:', e);
      }
    }
  }
}
