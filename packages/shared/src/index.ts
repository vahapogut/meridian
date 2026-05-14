/**
 * Meridian Shared — Public API
 *
 * @packageDocumentation
 */

// HLC — Hybrid Logical Clock
export {
  HLC,
  serializeHLC,
  deserializeHLC,
  compareHLC,
  compareHLCStrings,
  maxHLC,
  generateNodeId,
  type HLCTimestamp,
} from './hlc.js';

// CRDT — Last-Writer-Wins data structures
export {
  createRegister,
  mergeRegisters,
  createLWWMap,
  mergeLWWMaps,
  extractValues,
  extractMetadata,
  reconstructLWWMap,
  isDeleted,
  getLatestHLC,
  DELETED_FIELD,
  type LWWRegisterState,
  type LWWMap,
  type MergeResult,
  type ConflictRecord,
} from './crdt.js';

// Protocol — WebSocket message types
export {
  type CRDTOperation,
  type ServerChange,
  type ClientMessage,
  type ServerMessage,
  type PushMessage,
  type PullMessage,
  type SubscribeMessage,
  type PresenceSetMessage,
  type AuthMessage,
  type ChangesMessage,
  type AckMessage,
  type RejectMessage,
  type PresenceBroadcastMessage,
  type CompactionMessage,
  type FullSyncRequiredMessage,
  type AuthExpiringMessage,
  type AuthExpiredMessage,
  type ErrorMessage,
  type RejectCode,
  type ConnectionState,
  type PendingOp,
  type TabMessage,
} from './protocol.js';

// Schema — Definition & validation
export {
  z,
  defineSchema,
  getDefaults,
  validateAndNormalize,
  getFieldNames,
  fieldTypeToSQL,
  type FieldType,
  type FieldDefinition,
  type CollectionSchema,
  type SchemaDefinition,
  type InferDocument,
} from './schema.js';

// Permissions — Row-level access control DSL
export {
  defineRules,
  RuleEvaluator,
  type AuthContext,
  type DocAccessContext,
  type RuleFn,
  type CollectionRules,
  type PermissionRules,
} from './permissions.js';

// Storage — Backend adapter interface
export {
  type StorageAdapter,
  type StorageAdapterConfig,
  type PostgresAdapterConfig,
  type SQLiteAdapterConfig,
  type ConflictInfo,
} from './storage.js';

// Binary Codec — MessagePack-compatible encoder/decoder
export {
  encodeBinary,
  decodeBinary,
  estimateBinarySavings,
} from './binary-codec.js';

// Transport — Abstraction layer (WebSocket, WebRTC, TCP, Redis, etc.)
export {
  WebSocketTransport,
  createTransport,
  type Transport,
  type TransportConfig,
  type TransportType,
  type ExperimentalTransportType,
} from './transport.js';

// Crypto — E2E encryption layer
export {
  deriveKey,
  encryptValue,
  decryptValue,
  encryptFields,
  decryptFields,
  encryptOperation,
  generateRandomPassword,
  uint8ToBase64,
  base64ToUint8,
} from './crypto.js';
