/**
 * @meridian-sync/react-native — React Native client for Meridian
 *
 * @packageDocumentation
 *
 * Drop-in replacement for @meridian-sync/client that works in
 * React Native environments. Replaces IndexedDB with AsyncStorage,
 * drops BroadcastChannel (mobile apps are single-instance), and
 * provides the same reactive hooks API.
 *
 * Usage:
 * ```tsx
 * import { createRNClient, useQuery, useMutation } from '@meridian-sync/react-native';
 *
 * const db = createRNClient({
 *   schema,
 *   serverUrl: 'wss://api.example.com/sync',
 * });
 *
 * function TodoList() {
 *   const todos = useQuery(db.todos.find());
 *   // ...
 * }
 * ```
 */

// Client
export { createRNClient, type RNClientConfig, type RNClient } from './rn-client.js';

// React hooks (same API as @meridian-sync/react)
export {
  useQuery,
  useQueryOptimized,
  useLiveQuery,
  useDoc,
  useSync,
  usePresence,
  useMutation,
} from './hooks.js';

// Re-exports from shared
export {
  defineSchema,
  z,
  type SchemaDefinition,
  type ConnectionState,
  type PendingOp,
  type ConflictRecord,
} from '@meridian-sync/shared';
