/**
 * Meridian — Sync Compression
 *
 * Reduces network traffic for rapid operations:
 * 1. Debouncing — rapid typing on the same field only sends the latest value
 * 2. Delta encoding — for string fields, optionally send only the diff
 * 3. Batch merging — coalesce multiple ops on the same doc+field into one
 *
 * Usage (automatic in SyncEngine):
 * ```ts
 * const compressor = new SyncCompressor({ debounceMs: 150 });
 * const compressed = compressor.compress(pendingOps);
 * ```
 */

import type { CRDTOperation, PendingOp } from 'meridian-shared';

export interface CompressionConfig {
  /** Debounce window in ms — ops to the same field within this window are merged */
  debounceMs: number;
  /** Maximum ops per push message (prevents oversized messages) */
  maxBatchSize: number;
}

const DEFAULT_CONFIG: CompressionConfig = {
  debounceMs: 150,
  maxBatchSize: 100,
};

/**
 * Compresses pending operations by debouncing and merging.
 *
 * Rules:
 * - If two ops target the same (collection, docId, field), keep only the latest
 * - If an op was created < debounceMs ago, defer it to the next push
 * - Never exceed maxBatchSize ops per push
 */
export class SyncCompressor {
  private config: CompressionConfig;

  constructor(config: Partial<CompressionConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Compress a list of pending operations.
   * Returns { toSend, deferred } — toSend is ready, deferred stays in queue.
   */
  compress(ops: PendingOp[]): { toSend: PendingOp[]; deferred: PendingOp[] } {
    if (ops.length === 0) return { toSend: [], deferred: [] };

    const now = Date.now();
    const toSend: PendingOp[] = [];
    const deferred: PendingOp[] = [];
    const seen = new Map<string, number>(); // key → index in toSend

    for (const op of ops) {
      const key = `${op.op.collection}:${op.op.docId}:${op.op.field}`;

      // Debounce: defer if created too recently
      if (now - op.createdAt < this.config.debounceMs) {
        deferred.push(op);
        continue;
      }

      // Deduplicate: keep only the latest op per field
      if (seen.has(key)) {
        const existingIdx = seen.get(key)!;
        const existing = toSend[existingIdx];
        // Replace existing with this newer op
        if (op.createdAt > existing.createdAt) {
          toSend[existingIdx] = op;
        }
      } else {
        seen.set(key, toSend.length);
        toSend.push(op);
      }
    }

    // Enforce batch size limit
    if (toSend.length > this.config.maxBatchSize) {
      const overflow = toSend.splice(this.config.maxBatchSize);
      deferred.push(...overflow);
    }

    return { toSend, deferred };
  }

  /**
   * Delta-encode a string value against a previous value.
   * Returns a compact representation for sequential edits.
   */
  static deltaEncode(previous: string, current: string): string | null {
    if (previous === current) return null;
    if (!previous) return current;

    // Find common prefix
    let prefixLen = 0;
    while (prefixLen < previous.length && prefixLen < current.length &&
           previous[prefixLen] === current[prefixLen]) {
      prefixLen++;
    }

    // Find common suffix
    let suffixLen = 0;
    const maxSuffix = Math.min(
      previous.length - prefixLen,
      current.length - prefixLen
    );
    while (suffixLen < maxSuffix &&
           previous[previous.length - 1 - suffixLen] ===
           current[current.length - 1 - suffixLen]) {
      suffixLen++;
    }

    // Only use delta if it saves bytes
    const delta = `${prefixLen}:${current.slice(prefixLen, current.length - suffixLen)}:${suffixLen}`;
    if (delta.length < current.length) return delta;
    return current; // Delta not worth it, send full value
  }

  /**
   * Apply a delta-encoded value to reconstruct the full string.
   */
  static deltaDecode(previous: string, delta: string): string {
    const parts = delta.split(':');
    if (parts.length !== 3) return delta; // Not a delta, full value

    const prefixLen = parseInt(parts[0], 10);
    const middle = parts[1];
    const suffixLen = parseInt(parts[2], 10);

    return previous.slice(0, prefixLen) + middle +
           previous.slice(previous.length - suffixLen);
  }
}
