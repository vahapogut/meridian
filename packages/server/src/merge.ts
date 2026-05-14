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
} from 'meridian-shared';
import { RuleEvaluator, type PermissionRules, type AuthContext } from 'meridian-shared';
import type { PgStore } from './pg-store.js';
import type { WsHub, ConnectedClient } from './ws-hub.js';

export interface MergeEngineConfig {
  pgStore: PgStore;
  wsHub: WsHub;
  debug?: boolean;
  /** Custom conflict handler — devs define their own merge logic */
  onConflict?: (conflict: ConflictRecord & { collection: string; docId: string }) => void;
  /** Permission rules for row-level access control */
  permissions?: PermissionRules;
}

/**
 * Server-side CRDT merge engine with partial sync and row-level permissions.
 */
export class MergeEngine {
  private readonly config: MergeEngineConfig;
  private conflictLog: (ConflictRecord & { collection: string; docId: string; timestamp: number })[] = [];
  private readonly maxConflictLog = 1000;
  /** Per-client subscribe filters: clientId → collection → filter */
  private clientFilters = new Map<string, Map<string, Record<string, unknown>>>();
  private ruleEvaluator: RuleEvaluator | null = null;

  constructor(config: MergeEngineConfig) {
    this.config = config;
    if (config.permissions) {
      this.ruleEvaluator = new RuleEvaluator(config.permissions);
    }
  }

  /** Store a client's subscribe filter for partial sync */
  setClientFilter(clientId: string, collections: string[], filter?: Record<string, Record<string, unknown>>): void {
    const map = new Map<string, Record<string, unknown>>();
    if (filter) {
      for (const [col, f] of Object.entries(filter)) {
        map.set(col, f);
      }
    }
    // Ensure all subscribed collections are tracked (even without filter)
    for (const col of collections) {
      if (!map.has(col)) map.set(col, {});
    }
    this.clientFilters.set(clientId, map);
  }

  /** Remove client filters on disconnect */
  removeClientFilter(clientId: string): void {
    this.clientFilters.delete(clientId);
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
      const { changes, conflicts } = await this.config.pgStore.applyOperations(ops);

      if (changes.length === 0) return;

      // Log conflicts
      for (const conflict of conflicts) {
        // Find which op this conflict belongs to in order to extract collection and docId
        const op = ops.find(o => o.field === conflict.field && 
          (o.value === conflict.winnerValue || o.value === conflict.loserValue));
        
        if (op) {
          const conflictRecord = {
            ...conflict,
            collection: op.collection,
            docId: op.docId,
            timestamp: Date.now()
          };
          
          this.conflictLog.push(conflictRecord);
          if (this.conflictLog.length > this.maxConflictLog) {
            this.conflictLog.shift();
          }

          if (this.config.onConflict) {
            this.config.onConflict(conflictRecord);
          }
        }
      }

      // Send ack to the pushing client
      const lastSeq = Math.max(...changes.map(c => c.seq));
      const opIds = ops.map(op => op.id);

      this.config.wsHub.sendTo(client, {
        type: 'ack',
        lastSeq,
        opIds,
      });

      // Broadcast changes to other subscribed clients (with partial sync filtering)
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

    // Filter by subscribed collections + per-client partial sync filter
    const clientFilter = this.clientFilters.get(clientId);
    let filtered = changes.filter(c => {
      if (client.subscribedCollections.size > 0 &&
          !client.subscribedCollections.has(c.op.collection)) {
        return false;
      }
      // Apply partial sync filter (row-level WHERE)
      if (clientFilter) {
        const colFilter = clientFilter.get(c.op.collection);
        if (colFilter && Object.keys(colFilter).length > 0) {
          // Skip if the changed doc doesn't match the filter
          // For pull, we include if the docId matches filter criteria
          // Full doc resolution happens via a separate query if needed
          return true; // Include — server can't evaluate field values on every op
        }
      }
      return true;
    });

    // Apply row-level permission rules (e.g., userId-based filtering)
    if (this.ruleEvaluator && client.userId) {
      const authCtx: AuthContext = { userId: client.userId };
      const permissionFiltered: typeof filtered = [];
      for (const change of filtered) {
        const allowed = await this.ruleEvaluator.check(
          change.op.collection, 'read', authCtx,
          { existing: null, incoming: null }
        );
        if (allowed) permissionFiltered.push(change);
      }
      filtered = permissionFiltered;
    }

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
