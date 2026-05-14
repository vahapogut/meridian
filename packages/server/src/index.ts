/**
 * Meridian Server — Public API
 *
 * @packageDocumentation
 */

export { createServer, type MeridianServerConfig, type MeridianServer } from './server.js';
export { PgStore, type PgStoreConfig } from './pg-store.js';
export { WsHub, type WsHubConfig, type ConnectedClient, type AuthResult } from './ws-hub.js';
export { MergeEngine, type MergeEngineConfig } from './merge.js';
export { ServerPresenceManager } from './presence.js';
export { CompactionManager, type CompactionConfig } from './compaction.js';
export { createWALStream, type WALStreamConfig, type WALChange } from './wal-stream.js';
export { SQLiteStore, type SQLiteStoreConfig, type SQLDriver, type SQLStatement } from './sqlite-store.js';

// Re-export from shared for convenience
export {
  defineSchema,
  z,
  type SchemaDefinition,
  type CRDTOperation,
  type ServerChange,
  type ConflictRecord,
} from '@meridian-sync/shared';
