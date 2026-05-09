/**
 * Meridian — CRDT Data Structures
 *
 * Implements Last-Writer-Wins (LWW) conflict-free replicated data types:
 * - LWWRegister: Single value with HLC timestamp
 * - LWWMap: Map of field names → LWW registers (represents one document/row)
 * - mergeLWWMaps: Deterministic field-by-field merge of two maps
 *
 * Every field in a document is an independent LWW register, enabling
 * concurrent edits to different fields without data loss.
 */

import { type HLCTimestamp, compareHLC, compareHLCStrings, deserializeHLC, serializeHLC } from './hlc.js';

// ─── LWW Register ────────────────────────────────────────────────────────────

/**
 * State of a Last-Writer-Wins Register.
 * Stores a value alongside the HLC timestamp of when it was set.
 */
export interface LWWRegisterState<T = unknown> {
  /** The current value */
  value: T;
  /** HLC timestamp as string (serialized) */
  hlc: string;
  /** Node ID that set this value */
  nodeId: string;
}

/**
 * Create a new LWW register state.
 */
export function createRegister<T>(value: T, hlc: string, nodeId: string): LWWRegisterState<T> {
  return { value, hlc, nodeId };
}

/**
 * Merge two LWW register states.
 * The register with the higher HLC wins.
 * On HLC tie, the higher nodeId wins (deterministic).
 *
 * @returns The winning register state
 */
export function mergeRegisters<T>(
  local: LWWRegisterState<T>,
  remote: LWWRegisterState<T>
): LWWRegisterState<T> {
  const cmp = compareHLCStrings(local.hlc, remote.hlc);

  if (cmp > 0) return local;
  if (cmp < 0) return remote;

  // HLC tie — nodeId breaks it deterministically
  return local.nodeId >= remote.nodeId ? local : remote;
}

// ─── LWW Map (Document) ──────────────────────────────────────────────────────

/** Reserved field name for soft-delete tombstone */
export const DELETED_FIELD = '__deleted';

/**
 * An LWW-Map represents a single document/row.
 * Each field is an independent LWW register.
 *
 * Structure:
 * {
 *   "title":      { value: "Buy milk",  hlc: "...", nodeId: "..." },
 *   "done":       { value: false,       hlc: "...", nodeId: "..." },
 *   "__deleted":  { value: false,       hlc: "...", nodeId: "..." },
 * }
 */
export type LWWMap = Record<string, LWWRegisterState>;

/**
 * Create a new LWW-Map from a plain object.
 * All fields get the same initial HLC timestamp.
 */
export function createLWWMap(
  fields: Record<string, unknown>,
  hlc: string,
  nodeId: string
): LWWMap {
  const map: LWWMap = {};

  for (const [key, value] of Object.entries(fields)) {
    map[key] = createRegister(value, hlc, nodeId);
  }

  // Always include deletion flag
  if (!(DELETED_FIELD in map)) {
    map[DELETED_FIELD] = createRegister(false, hlc, nodeId);
  }

  return map;
}

/**
 * Merge two LWW-Maps field by field.
 * Each field is independently merged using LWW register semantics.
 * Fields present in one map but not the other are included as-is.
 *
 * @returns The merged map and a list of conflicts
 */
export function mergeLWWMaps(local: LWWMap, remote: LWWMap): MergeResult {
  const merged: LWWMap = {};
  const conflicts: ConflictRecord[] = [];

  // Collect all field names from both maps
  const allFields = new Set([...Object.keys(local), ...Object.keys(remote)]);

  for (const field of allFields) {
    const localReg = local[field];
    const remoteReg = remote[field];

    if (!localReg) {
      // Field only exists in remote
      merged[field] = remoteReg;
    } else if (!remoteReg) {
      // Field only exists in local
      merged[field] = localReg;
    } else {
      // Both exist — merge
      const winner = mergeRegisters(localReg, remoteReg);
      merged[field] = winner;

      // Track conflict if values differ and one was overwritten
      if (localReg.value !== remoteReg.value) {
        const loser = winner === localReg ? remoteReg : localReg;
        conflicts.push({
          field,
          winnerValue: winner.value,
          winnerHlc: winner.hlc,
          winnerNodeId: winner.nodeId,
          loserValue: loser.value,
          loserHlc: loser.hlc,
          loserNodeId: loser.nodeId,
        });
      }
    }
  }

  return { merged, conflicts };
}

/**
 * Extract the plain values from an LWW-Map (strip CRDT metadata).
 * Excludes the __deleted field.
 */
export function extractValues(map: LWWMap): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, reg] of Object.entries(map)) {
    if (key === DELETED_FIELD) continue;
    result[key] = reg.value;
  }

  return result;
}

/**
 * Check if a document is soft-deleted.
 */
export function isDeleted(map: LWWMap): boolean {
  return map[DELETED_FIELD]?.value === true;
}

/**
 * Get the latest HLC string across all fields in a map.
 * Used for determining the document's "last updated" time.
 */
export function getLatestHLC(map: LWWMap): string {
  let latest = '';

  for (const reg of Object.values(map)) {
    if (!latest || compareHLCStrings(reg.hlc, latest) > 0) {
      latest = reg.hlc;
    }
  }

  return latest;
}

/**
 * Extract the HLC metadata map (field → hlc string).
 * Used for _meridian_meta JSONB column in PostgreSQL.
 */
export function extractMetadata(map: LWWMap): Record<string, string> {
  const meta: Record<string, string> = {};

  for (const [key, reg] of Object.entries(map)) {
    meta[key] = reg.hlc;
  }

  return meta;
}

/**
 * Reconstruct an LWW-Map from plain values + metadata.
 * Inverse of extractValues + extractMetadata.
 */
export function reconstructLWWMap(
  values: Record<string, unknown>,
  metadata: Record<string, string>,
  defaultNodeId: string = 'server'
): LWWMap {
  const map: LWWMap = {};

  for (const [key, value] of Object.entries(values)) {
    const hlc = metadata[key];
    if (hlc) {
      const parsed = deserializeHLC(hlc);
      map[key] = createRegister(value, hlc, parsed.nodeId);
    } else {
      // No metadata — create with epoch time (lowest priority)
      map[key] = createRegister(value, '0-0000-' + defaultNodeId, defaultNodeId);
    }
  }

  // Include __deleted if present in metadata
  if (metadata[DELETED_FIELD]) {
    const deletedValue = values[DELETED_FIELD] ?? false;
    const parsed = deserializeHLC(metadata[DELETED_FIELD]);
    map[DELETED_FIELD] = createRegister(deletedValue, metadata[DELETED_FIELD], parsed.nodeId);
  }

  return map;
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MergeResult {
  /** The merged LWW-Map */
  merged: LWWMap;
  /** List of field-level conflicts (for logging/debugging) */
  conflicts: ConflictRecord[];
}

export interface ConflictRecord {
  /** Field name where conflict occurred */
  field: string;
  /** The value that won */
  winnerValue: unknown;
  /** HLC of the winning write */
  winnerHlc: string;
  /** Node that performed the winning write */
  winnerNodeId: string;
  /** The value that was overwritten */
  loserValue: unknown;
  /** HLC of the losing write */
  loserHlc: string;
  /** Node that performed the losing write */
  loserNodeId: string;
}
