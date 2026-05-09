/**
 * Meridian Server — CRDT Merge Engine
 *
 * Handles server-side merge logic:
 * - Receives client operations
 * - Merges with existing PostgreSQL state
 * - Assigns sequence numbers
 * - Broadcasts results to other clients
 * - Logs conflicts for debugging
 */

import type {
  CRDTOperation,
  ServerChange,
  ConflictRecord,
} from '@meridian-sync/shared';
import type { PgStore } from './pg-store.js';
import type { WsHub, ConnectedClient } from './ws-hub.js';

export interface MergeEngineConfig {
  pgStore: PgStore;
  wsHub: WsHub;
  debug?: boolean;
  /** Custom conflict handler */
  onConflict?: (conflict: ConflictRecord & { collection: string; docId: string }) => void;
}

/**
 * Server-side CRDT merge engine.
 */
export class MergeEngine {
  private readonly config: MergeEngineConfig;
  private conflictLog: (ConflictRecord & { collection: string; docId: string; timestamp: number })[] = [];
  private readonly maxConflictLog = 1000;

  constructor(config: MergeEngineConfig) {
    this.config = config;
  }

  /**
   * Process a push from a client.
   * Merges operations with existing state, assigns seqNums, and broadcasts.
   *
   * @param clientId - The sending client's ID
   * @param ops - CRDT operations from the client
   * @param client - The connected client object
   */
  async processPush(
    clientId: string,
    ops: CRDTOperation[],
    client: ConnectedClient
  ): Promise<void> {
    if (ops.length === 0) return;

    this.log(`⬇️ Processing ${ops.length} ops from ${clientId}`);

    try {
      // Apply to PostgreSQL (with CRDT merge)
      const changes = await this.config.pgStore.applyOperations(ops);

      if (changes.length === 0) return;

      // Send ack to the pushing client
      const lastSeq = Math.max(...changes.map(c => c.seq));
      const opIds = ops.map(op => op.id);

      this.config.wsHub.sendTo(client, {
        type: 'ack',
        lastSeq,
        opIds,
      });

      // Broadcast changes to other subscribed clients
      const collections = new Set(ops.map(op => op.collection));
      for (const collection of collections) {
        const collectionChanges = changes.filter(c => c.op.collection === collection);

        if (collectionChanges.length > 0) {
          this.config.wsHub.broadcastToCollection(
            collection,
            { type: 'changes', changes: collectionChanges },
            clientId,
            client.namespace
          );
        }
      }

      this.log(`✅ Applied ${changes.length} changes, lastSeq=${lastSeq}`);
    } catch (e) {
      this.log(`❌ Merge failed:`, e);

      // Reject all operations
      for (const op of ops) {
        this.config.wsHub.sendTo(client, {
          type: 'reject',
          opId: op.id,
          code: 'VALIDATION',
          reason: e instanceof Error ? e.message : 'Merge failed',
        });
      }
    }
  }

  /**
   * Process a pull request from a client.
   * Returns changes since the given sequence number.
   */
  async processPull(
    clientId: string,
    since: number,
    client: ConnectedClient
  ): Promise<void> {
    this.log(`⬇️ Pull request from ${clientId}: since=${since}`);

    const changes = await this.config.pgStore.getChangesSince(since);

    if (changes === null) {
      // Compaction gap — client needs full re-sync
      this.config.wsHub.sendTo(client, {
        type: 'full-sync-required',
        reason: 'compaction',
        minSeq: this.config.pgStore.getMinSeq(),
      });
      return;
    }

    // Filter by client's subscribed collections and namespace
    const filtered = changes.filter(c =>
      client.subscribedCollections.size === 0 ||
      client.subscribedCollections.has(c.op.collection)
    );

    if (filtered.length > 0) {
      this.config.wsHub.sendTo(client, {
        type: 'changes',
        changes: filtered,
      });
    }

    this.log(`📤 Sent ${filtered.length} changes to ${clientId}`);
  }

  /**
   * Get the conflict log.
   */
  getConflictLog() {
    return [...this.conflictLog];
  }

  private log(...args: unknown[]): void {
    if (this.config.debug) {
      console.log('[Meridian Merge]', ...args);
    }
  }
}
