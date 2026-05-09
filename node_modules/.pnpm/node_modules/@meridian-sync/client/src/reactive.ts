/**
 * Meridian Client — Reactive Query System
 *
 * Provides Observable-like queries that automatically re-execute
 * when underlying data changes. Powered by the store's change
 * listener system.
 *
 * Usage:
 * ```ts
 * db.todos.find({ done: false }).subscribe((todos) => {
 *   renderTodoList(todos);
 * });
 * ```
 */

import type { MeridianStore } from './store.js';
import type { HLC } from '@meridian-sync/shared';

// ─── Types ───────────────────────────────────────────────────────────────────

export type Subscriber<T> = (data: T) => void;
export type Unsubscribe = () => void;

export interface Query<T> {
  /** Subscribe to query results — callback fires on every data change */
  subscribe(callback: Subscriber<T>): Unsubscribe;
  /** Get current result (one-shot, non-reactive) */
  get(): Promise<T>;
}

// ─── Collection Proxy ────────────────────────────────────────────────────────

/**
 * Proxy object for a collection — provides CRUD + reactive queries.
 *
 * Methods:
 * - find(filter?) — Reactive query for multiple documents
 * - findOne(id) — Reactive query for a single document
 * - put(doc) — Create or replace a document
 * - update(id, fields) — Update specific fields
 * - delete(id) — Soft-delete a document
 */
export class CollectionProxy {
  private readonly collection: string;
  private readonly store: MeridianStore;
  private readonly clock: HLC;

  constructor(collection: string, store: MeridianStore, clock: HLC) {
    this.collection = collection;
    this.store = store;
    this.clock = clock;
  }

  /**
   * Reactive query for multiple documents.
   *
   * @param filter - Optional field-value filter
   * @returns Query object with subscribe() and get()
   */
  find(filter?: Record<string, unknown>): Query<Record<string, unknown>[]> {
    const collection = this.collection;
    const store = this.store;

    return {
      subscribe: (callback: Subscriber<Record<string, unknown>[]>): Unsubscribe => {
        // Execute initial query
        store.queryDocs(collection, filter).then(callback);

        // Re-execute on changes
        const unsubscribe = store.onCollectionChange(collection, () => {
          store.queryDocs(collection, filter).then(callback);
        });

        return unsubscribe;
      },

      get: () => store.queryDocs(collection, filter),
    };
  }

  /**
   * Reactive query for a single document by ID.
   *
   * @param id - Document ID
   * @returns Query object with subscribe() and get()
   */
  findOne(id: string): Query<Record<string, unknown> | null> {
    const collection = this.collection;
    const store = this.store;

    return {
      subscribe: (callback: Subscriber<Record<string, unknown> | null>): Unsubscribe => {
        // Execute initial query
        store.getDoc(collection, id).then(callback);

        // Re-execute only when this specific doc changes
        const unsubscribe = store.onCollectionChange(collection, (docId) => {
          if (docId === id) {
            store.getDoc(collection, id).then(callback);
          }
        });

        return unsubscribe;
      },

      get: () => store.getDoc(collection, id),
    };
  }

  /**
   * Create or replace a document.
   *
   * If a document with the same ID exists, all fields are overwritten.
   * The operation is immediately written to IndexedDB and queued for sync.
   *
   * @param doc - Document with `id` field
   */
  async put(doc: Record<string, unknown>): Promise<void> {
    if (!doc.id) {
      doc.id = crypto.randomUUID();
    }

    const hlcTs = this.clock.now();
    const hlcStr = `${hlcTs.wallTime}-${hlcTs.counter.toString().padStart(4, '0')}-${hlcTs.nodeId}`;

    await this.store.putDoc(this.collection, doc, hlcStr, hlcTs.nodeId);
  }

  /**
   * Update specific fields of an existing document.
   *
   * Only the specified fields are updated — other fields remain unchanged.
   * Generates field-level CRDT operations for minimal sync overhead.
   *
   * @param id - Document ID
   * @param fields - Fields to update
   */
  async update(id: string, fields: Record<string, unknown>): Promise<void> {
    const hlcTs = this.clock.now();
    const hlcStr = `${hlcTs.wallTime}-${hlcTs.counter.toString().padStart(4, '0')}-${hlcTs.nodeId}`;

    await this.store.updateDoc(this.collection, id, fields, hlcStr, hlcTs.nodeId);
  }

  /**
   * Soft-delete a document.
   *
   * The document is marked as deleted (tombstone) but not physically removed.
   * It will be permanently removed during server-side compaction.
   *
   * @param id - Document ID
   */
  async delete(id: string): Promise<void> {
    const hlcTs = this.clock.now();
    const hlcStr = `${hlcTs.wallTime}-${hlcTs.counter.toString().padStart(4, '0')}-${hlcTs.nodeId}`;

    await this.store.deleteDoc(this.collection, id, hlcStr, hlcTs.nodeId);
  }
}
