/**
 * MeridianDB — GraphQL Subscription Support
 *
 * Real-time sync via GraphQL subscriptions over WebSocket.
 * Integrates with Apollo Server, yoga, or any graphql-ws compatible server.
 *
 * Usage:
 * ```ts
 * import { MeridianPubSub } from 'meridian-server';
 *
 * const pubsub = new MeridianPubSub(mergeEngine);
 *
 * // With Apollo Server:
 * const server = new ApolloServer({
 *   resolvers: {
 *     Subscription: {
 *       todosChanged: {
 *         subscribe: () => pubsub.asyncIterator('todos'),
 *       },
 *     },
 *   },
 * });
 * ```
 */

import type { ServerChange } from 'meridian-shared';

// ─── PubSub ────────────────────────────────────────────────────────────────

interface PubSubCallback { (change: MeridianChange): void }

export interface MeridianChange {
  collection: string;
  docId: string;
  field: string;
  value: unknown;
  operation: 'INSERT' | 'UPDATE' | 'DELETE';
  seq: number;
}

interface IteratorHandle { id: string; collection: string; callback: PubSubCallback; }

export class MeridianPubSub {
  private listeners = new Map<string, Set<PubSubCallback>>();
  private iterators = new Map<string, IteratorHandle>();

  /** Publish a change to all subscribers of the given collection */
  publish(change: MeridianChange): void {
    const subs = this.listeners.get(change.collection);
    if (subs) {
      for (const cb of subs) cb(change);
    }

    // Also notify iterators
    for (const [id, handle] of this.iterators) {
      if (handle.collection === change.collection) {
        handle.callback(change);
      }
    }
  }

  /**
   * Subscribe to changes on a collection.
   * Returns an AsyncIterator compatible with graphql-ws protocol.
   */
  asyncIterator(collection: string): AsyncIterator<MeridianChange> {
    const id = `${collection}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    let resolveNext: ((value: IteratorResult<MeridianChange>) => void) | null = null;
    let done = false;

    const handle: IteratorHandle = {
      id,
      collection,
      callback: (change) => {
        if (resolveNext) {
          resolveNext({ value: change, done: false });
          resolveNext = null;
        }
      },
    };

    this.iterators.set(id, handle);

    return {
      next: () => new Promise<IteratorResult<MeridianChange>>((resolve) => {
        resolveNext = resolve;
      }),
      return: () => {
        this.iterators.delete(id);
        done = true;
        if (resolveNext) resolveNext({ value: undefined, done: true });
        return Promise.resolve({ value: undefined, done: true });
      },
      throw: (e) => {
        this.iterators.delete(id);
        done = true;
        return Promise.reject(e);
      },
    };
  }

  /**
   * Subscribe with a callback. Returns an unsubscribe function.
   */
  subscribe(collection: string, callback: PubSubCallback): () => void {
    if (!this.listeners.has(collection)) {
      this.listeners.set(collection, new Set());
    }
    this.listeners.get(collection)!.add(callback);
    return () => { this.listeners.get(collection)?.delete(callback); };
  }
}

// ─── Bridge: MergeEngine → PubSub ─────────────────────────────────────────

/**
 * Bridge MeridianDB MergeEngine changes to a MeridianPubSub.
 *
 * ```ts
 * bridgeToGraphQL(mergeEngine, pubsub);
 * ```
 */
export function bridgeToGraphQL(
  mergeEngine: { on?: (event: string, cb: (change: unknown) => void) => void },
  pubsub: MeridianPubSub
): void {
  // Hook into merge engine — after each applied operation, publish to pubsub
  if (mergeEngine.on) {
    mergeEngine.on('change', (change: unknown) => {
      const c = change as MeridianChange;
      pubsub.publish({
        collection: c.collection,
        docId: c.docId,
        field: c.field,
        value: c.value,
        operation: c.operation,
        seq: c.seq,
      });
    });
  }
}
