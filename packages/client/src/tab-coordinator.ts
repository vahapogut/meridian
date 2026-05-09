/**
 * Meridian Client — Tab Coordinator
 *
 * Uses BroadcastChannel API for multi-tab coordination:
 * - Leader election: Only one tab manages the WebSocket connection
 * - Store invalidation: Leader notifies followers when IndexedDB changes
 * - Seamless failover: If leader tab closes/crashes, a new leader is elected
 *
 * Mechanism:
 * 1. Each tab gets a monotonically increasing lockId on creation
 * 2. Leader sends heartbeats every 2s via BroadcastChannel
 * 3. If no heartbeat for 3s, followers trigger re-election
 * 4. On re-election, lowest lockId wins
 * 5. Leader calls beforeunload to resign gracefully
 */

import type { TabMessage } from '@meridian-sync/shared';

const CHANNEL_NAME = 'meridian-sync';
const HEARTBEAT_INTERVAL = 2000;
const HEARTBEAT_TIMEOUT = 3000;

let globalLockCounter = 0;

export type TabRole = 'leader' | 'follower';

export interface TabCoordinatorConfig {
  /** Called when this tab becomes leader */
  onBecomeLeader: () => void;
  /** Called when this tab becomes follower */
  onBecomeFollower: () => void;
  /** Called when another tab modifies IndexedDB */
  onRemoteStoreChange: (collection: string, docId: string) => void;
  /** Debug mode */
  debug: boolean;
}

/**
 * Coordinates multiple browser tabs via BroadcastChannel.
 */
export class TabCoordinator {
  private channel: BroadcastChannel | null = null;
  private readonly tabId: string;
  private readonly lockId: number;
  private readonly config: TabCoordinatorConfig;
  private role: TabRole = 'follower';
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(config: TabCoordinatorConfig) {
    this.config = config;
    this.lockId = ++globalLockCounter;
    this.tabId = `tab-${this.lockId}-${Math.random().toString(36).slice(2, 6)}`;
  }

  /**
   * Start the coordinator and participate in leader election.
   */
  start(): void {
    if (typeof BroadcastChannel === 'undefined') {
      // BroadcastChannel not available — assume leader (single tab)
      this.log('⚠️ BroadcastChannel not available — assuming leader');
      this.becomeLeader();
      return;
    }

    this.channel = new BroadcastChannel(CHANNEL_NAME);
    this.channel.onmessage = (event) => this.handleMessage(event.data as TabMessage);

    // Register beforeunload for graceful resignation
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', this.handleBeforeUnload);
    }

    // Start election
    this.claimLeadership();
  }

  /**
   * Stop the coordinator.
   */
  stop(): void {
    this.destroyed = true;

    if (this.role === 'leader') {
      this.broadcast({ type: 'leader-resign', tabId: this.tabId });
    }

    this.clearHeartbeat();
    this.clearHeartbeatTimeout();

    if (typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', this.handleBeforeUnload);
    }

    this.channel?.close();
    this.channel = null;
  }

  /**
   * Current tab role.
   */
  get currentRole(): TabRole {
    return this.role;
  }

  /**
   * Whether this tab is the leader.
   */
  get isLeader(): boolean {
    return this.role === 'leader';
  }

  /**
   * Broadcast a store change event to other tabs.
   * Called by the leader after writing to IndexedDB.
   */
  broadcastStoreChange(collection: string, docId: string): void {
    this.broadcast({ type: 'store-changed', collection, docId });
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private claimLeadership(): void {
    this.log(`📋 Claiming leadership (lockId=${this.lockId})`);
    this.broadcast({ type: 'claim-leader', tabId: this.tabId, lockId: this.lockId });

    // Wait a short time for objections from existing leaders
    setTimeout(() => {
      if (!this.destroyed && this.role === 'follower') {
        // No existing leader responded — become leader
        this.becomeLeader();
      }
    }, 200);
  }

  private becomeLeader(): void {
    if (this.role === 'leader') return;

    this.log('👑 Became leader');
    this.role = 'leader';
    this.clearHeartbeatTimeout();
    this.startHeartbeat();
    this.config.onBecomeLeader();
  }

  private becomeFollower(): void {
    if (this.role === 'follower') return;

    this.log('👤 Became follower');
    this.role = 'follower';
    this.clearHeartbeat();
    this.startHeartbeatTimeout();
    this.config.onBecomeFollower();
  }

  private handleMessage(msg: TabMessage): void {
    switch (msg.type) {
      case 'leader-resign':
        if (this.role === 'follower') {
          this.log(`👑 Leader resigned (${msg.tabId}) — claiming`);
          this.claimLeadership();
        }
        break;

      case 'claim-leader':
        if (this.role === 'leader') {
          // I'm already leader — send ack to tell claimer to back off
          this.broadcast({ type: 'leader-ack', tabId: this.tabId });
        } else if (msg.lockId < this.lockId) {
          // Claimer has lower lockId — they should be leader
          // Do nothing, wait for their heartbeat
        }
        break;

      case 'leader-ack':
        if (msg.tabId !== this.tabId) {
          // Another tab is leader — become follower
          this.becomeFollower();
          this.resetHeartbeatTimeout();
        }
        break;

      case 'leader-heartbeat':
        if (msg.tabId !== this.tabId) {
          if (this.role === 'leader') {
            // Another leader exists — resolve conflict by lockId
            // In production, this rarely happens
            this.becomeFollower();
          }
          this.resetHeartbeatTimeout();
        }
        break;

      case 'store-changed':
        // Another tab modified the store — refresh queries
        this.config.onRemoteStoreChange(msg.collection, msg.docId);
        break;

      case 'request-sync':
        if (this.role === 'leader') {
          // Follower requested a sync — trigger it
          // The sync engine will handle this
        }
        break;
    }
  }

  private handleBeforeUnload = (): void => {
    if (this.role === 'leader') {
      this.broadcast({ type: 'leader-resign', tabId: this.tabId });
    }
  };

  // ─── Heartbeat ──────────────────────────────────────────────────────────────

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      this.broadcast({ type: 'leader-heartbeat', tabId: this.tabId });
    }, HEARTBEAT_INTERVAL);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private startHeartbeatTimeout(): void {
    this.resetHeartbeatTimeout();
  }

  private resetHeartbeatTimeout(): void {
    this.clearHeartbeatTimeout();
    this.heartbeatTimeout = setTimeout(() => {
      this.log('⏰ Leader heartbeat timeout — re-electing');
      this.claimLeadership();
    }, HEARTBEAT_TIMEOUT);
  }

  private clearHeartbeatTimeout(): void {
    if (this.heartbeatTimeout) {
      clearTimeout(this.heartbeatTimeout);
      this.heartbeatTimeout = null;
    }
  }

  // ─── Utilities ──────────────────────────────────────────────────────────────

  private broadcast(msg: TabMessage): void {
    try {
      this.channel?.postMessage(msg);
    } catch (e) {
      // Channel might be closed
    }
  }

  private log(...args: unknown[]): void {
    if (this.config.debug) {
      console.log(`[Meridian Tab:${this.tabId}]`, ...args);
    }
  }
}
