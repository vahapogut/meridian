/**
 * Meridian Server — Presence Manager (Server-side)
 *
 * In-memory presence state for connected clients.
 * - Stores presence data per client
 * - Broadcasts updates to all peers
 * - Auto-cleanup on disconnect (no TTL needed — instant)
 */

import type { WsHub, ConnectedClient } from './ws-hub.js';

export type PresenceData = Record<string, unknown>;

export class ServerPresenceManager {
  private presence: Map<string, PresenceData> = new Map();
  private wsHub: WsHub;
  private debug: boolean;

  constructor(wsHub: WsHub, debug = false) {
    this.wsHub = wsHub;
    this.debug = debug;
  }

  /**
   * Update presence for a client and broadcast to peers.
   */
  update(clientId: string, data: PresenceData, client: ConnectedClient): void {
    this.presence.set(clientId, data);

    if (this.debug) {
      console.log(`[Meridian Presence] Updated: ${clientId}`, data);
    }

    this.broadcastAll(client.namespace);
  }

  /**
   * Remove presence for a disconnected client.
   */
  remove(clientId: string): void {
    const had = this.presence.delete(clientId);

    if (had && this.debug) {
      console.log(`[Meridian Presence] Removed: ${clientId}`);
    }

    // Broadcast updated peer list to remaining clients
    this.broadcastAll(null);
  }

  /**
   * Get all current presence data.
   */
  getAll(): Record<string, PresenceData> {
    return Object.fromEntries(this.presence);
  }

  /**
   * Send current presence state to a specific client (e.g., on reconnect).
   */
  sendCurrentState(client: ConnectedClient): void {
    this.wsHub.sendTo(client, {
      type: 'presence',
      peers: Object.fromEntries(this.presence),
    });
  }

  private broadcastAll(namespace: string | null): void {
    this.wsHub.broadcastToAll(
      {
        type: 'presence',
        peers: Object.fromEntries(this.presence),
      },
      namespace
    );
  }

  /**
   * Clear all presence data.
   */
  clear(): void {
    this.presence.clear();
  }
}
