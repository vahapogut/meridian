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
export { MySQLStore, type MySQLStoreConfig, type MySQLPool } from './mysql-store.js';
export { SnapshotManager, type Snapshot, type SnapshotConfig, type CollectionSnapshot } from './snapshot.js';
export { supabaseAuth, auth0Auth, clerkAuth, jwtAuth, type AuthAdapter, type AuthAdapterConfig } from './auth-adapters.js';
export { MetricsCollector, type MetricsSnapshot } from './metrics.js';
export { MeridianPubSub, bridgeToGraphQL, type MeridianChange } from './graphql.js';

// Re-export from shared for convenience
export {
  defineSchema,
  z,
  type SchemaDefinition,
  type CRDTOperation,
  type ServerChange,
  type ConflictRecord,
} from 'meridian-shared';
