/**
 * Meridian Client — Public API
 *
 * @packageDocumentation
 */

// Main entry point
export { createClient, type MeridianClientConfig, type MeridianClient } from './client.js';

// Re-export from shared for convenience
export {
  defineSchema,
  z,
  type SchemaDefinition,
  type ConnectionState,
  type PendingOp,
  type ConflictRecord,
} from '@meridian-sync/shared';

// Internal (for advanced use cases)
export { MeridianStore } from './store.js';
export { SyncEngine } from './sync.js';
export { CollectionProxy, type Query, type Subscriber, type Unsubscribe } from './reactive.js';
export { TabCoordinator, type TabRole } from './tab-coordinator.js';
export { PresenceManager, type PresenceData, type PresenceCallback } from './presence.js';
export { DebugManager } from './debug.js';
