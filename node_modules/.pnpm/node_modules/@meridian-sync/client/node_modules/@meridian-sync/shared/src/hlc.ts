/**
 * Meridian — Hybrid Logical Clock (HLC)
 *
 * Combines wall-clock time with a logical counter to provide:
 * - Monotonicity: HLC never goes backward even if system clock adjusts
 * - Causality: send/recv operations preserve happens-before ordering
 * - Compactness: Serializes to "wallTime-counter-nodeId" string
 *
 * Based on the paper: "Logical Physical Clocks and Consistent Snapshots
 * in Globally Distributed Databases" by Kulkarni et al.
 */

export interface HLCTimestamp {
  /** Wall-clock time in milliseconds */
  wallTime: number;
  /** Logical counter for ordering events within the same millisecond */
  counter: number;
  /** Unique identifier for the node/client that generated this timestamp */
  nodeId: string;
}

const MAX_COUNTER = 65535; // 16-bit counter — sufficient for <65k events/ms
const HLC_SEPARATOR = '-';

/**
 * Hybrid Logical Clock implementation.
 *
 * Usage:
 * ```ts
 * const clock = new HLC('client-abc');
 * const ts = clock.now();          // Generate timestamp for local event
 * const sent = clock.send();       // Generate timestamp for outgoing message
 * clock.recv(remoteTimestamp);      // Update clock with received timestamp
 * ```
 */
export class HLC {
  private _wallTime: number;
  private _counter: number;
  private readonly _nodeId: string;

  constructor(nodeId: string, initialTime?: number) {
    this._nodeId = nodeId;
    this._wallTime = initialTime ?? 0;
    this._counter = 0;
  }

  /** Current node ID */
  get nodeId(): string {
    return this._nodeId;
  }

  /**
   * Generate a timestamp for a local event.
   * Ensures monotonicity even if the system clock goes backward.
   */
  now(): HLCTimestamp {
    const physicalTime = Date.now();

    if (physicalTime > this._wallTime) {
      // Physical clock advanced — reset counter
      this._wallTime = physicalTime;
      this._counter = 0;
    } else {
      // Physical clock hasn't advanced (same ms or went backward)
      this._counter++;
      if (this._counter > MAX_COUNTER) {
        throw new Error(
          `[Meridian HLC] Counter overflow: more than ${MAX_COUNTER} events in 1ms. ` +
          `This indicates an unusually high event rate.`
        );
      }
    }

    return {
      wallTime: this._wallTime,
      counter: this._counter,
      nodeId: this._nodeId,
    };
  }

  /**
   * Generate a timestamp for an outgoing message.
   * Equivalent to `now()` but semantically indicates a send event.
   */
  send(): HLCTimestamp {
    return this.now();
  }

  /**
   * Update the local clock upon receiving a remote timestamp.
   * Merges the remote time with local time to maintain causal ordering.
   *
   * @param remote - The timestamp received from another node
   * @returns The updated local timestamp
   */
  recv(remote: HLCTimestamp): HLCTimestamp {
    const physicalTime = Date.now();

    if (physicalTime > this._wallTime && physicalTime > remote.wallTime) {
      // Local physical clock is ahead of both — reset counter
      this._wallTime = physicalTime;
      this._counter = 0;
    } else if (remote.wallTime > this._wallTime) {
      // Remote is ahead — adopt remote time, increment its counter
      this._wallTime = remote.wallTime;
      this._counter = remote.counter + 1;
    } else if (this._wallTime > remote.wallTime) {
      // Local HLC is ahead — just increment local counter
      this._counter++;
    } else {
      // Same wall time — take max counter + 1
      this._counter = Math.max(this._counter, remote.counter) + 1;
    }

    if (this._counter > MAX_COUNTER) {
      throw new Error(
        `[Meridian HLC] Counter overflow during recv. ` +
        `This may indicate severe clock skew between nodes.`
      );
    }

    return {
      wallTime: this._wallTime,
      counter: this._counter,
      nodeId: this._nodeId,
    };
  }

  /**
   * Get the current HLC state without advancing it.
   */
  peek(): HLCTimestamp {
    return {
      wallTime: this._wallTime,
      counter: this._counter,
      nodeId: this._nodeId,
    };
  }
}

// ─── Serialization ───────────────────────────────────────────────────────────

/**
 * Serialize an HLC timestamp to a string.
 * Format: "wallTime-counter-nodeId"
 * Example: "1715299200000-0001-ua7x2k"
 *
 * The counter is zero-padded to 4 digits for lexicographic sorting.
 */
export function serializeHLC(ts: HLCTimestamp): string {
  const counterStr = ts.counter.toString().padStart(4, '0');
  return `${ts.wallTime}${HLC_SEPARATOR}${counterStr}${HLC_SEPARATOR}${ts.nodeId}`;
}

/**
 * Deserialize a string back to an HLC timestamp.
 */
export function deserializeHLC(str: string): HLCTimestamp {
  const firstSep = str.indexOf(HLC_SEPARATOR);
  const secondSep = str.indexOf(HLC_SEPARATOR, firstSep + 1);

  if (firstSep === -1 || secondSep === -1) {
    throw new Error(`[Meridian HLC] Invalid HLC string: "${str}"`);
  }

  return {
    wallTime: parseInt(str.substring(0, firstSep), 10),
    counter: parseInt(str.substring(firstSep + 1, secondSep), 10),
    nodeId: str.substring(secondSep + 1),
  };
}

// ─── Comparison ──────────────────────────────────────────────────────────────

/**
 * Compare two HLC timestamps.
 *
 * Returns:
 * - negative if a < b
 * - positive if a > b
 * - 0 if equal
 *
 * Comparison order: wallTime → counter → nodeId (lexicographic tie-break)
 */
export function compareHLC(a: HLCTimestamp, b: HLCTimestamp): number {
  if (a.wallTime !== b.wallTime) {
    return a.wallTime - b.wallTime;
  }
  if (a.counter !== b.counter) {
    return a.counter - b.counter;
  }
  return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
}

/**
 * Compare two serialized HLC strings.
 * More efficient than deserializing both — leverages lexicographic ordering.
 */
export function compareHLCStrings(a: string, b: string): number {
  return compareHLC(deserializeHLC(a), deserializeHLC(b));
}

/**
 * Returns the greater of two HLC timestamps.
 */
export function maxHLC(a: HLCTimestamp, b: HLCTimestamp): HLCTimestamp {
  return compareHLC(a, b) >= 0 ? a : b;
}

/**
 * Generate a short random node ID (8 chars, alphanumeric).
 */
export function generateNodeId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  const array = new Uint8Array(8);

  // Use crypto.getRandomValues if available (browser), otherwise Math.random
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(array);
    for (let i = 0; i < 8; i++) {
      result += chars[array[i] % chars.length];
    }
  } else {
    for (let i = 0; i < 8; i++) {
      result += chars[Math.floor(Math.random() * chars.length)];
    }
  }

  return result;
}
