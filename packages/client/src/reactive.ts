/**
 * Meridian Client — Reactive Query System
 *
 * Provides Observable-like queries that automatically re-execute
 * when underlying data changes. Powered by the store's change
 * listener system.
 *
 * Usage:
 * ```ts
 * // Reactive subscription
 * db.todos.find({ done: false }).subscribe((todos) => renderTodoList(todos));
 *
 * // V2: Live query with ordering and limits
 * db.todos.live({ where: { done: false }, orderBy: 'createdAt', limit: 50 })
 *   .subscribe((todos) => renderTodoList(todos));
 * ```
 */

import type { MeridianStore } from './store.js';
import type { HLC } from 'meridian-shared';

// ─── Types ───────────────────────────────────────────────────────────────────

export type Subscriber<T> = (data: T) => void;
export type Unsubscribe = () => void;

export interface Query<T> {
  /** Subscribe to query results — callback fires on every data change */
  subscribe(callback: Subscriber<T>): Unsubscribe;
  /** Get current result (one-shot, non-reactive) */
  get(): Promise<T>;
}

/** V2 live query options */
export interface LiveQueryOptions {
  /** Field-value filter (equal match) */
  where?: Record<string, unknown>;
  /** Field to order by */
  orderBy?: string;
  /** Maximum number of documents to return */
  limit?: number;
}

// ─── Collection Proxy ────────────────────────────────────────────────────────

/**
 * Proxy object for a collection — provides CRUD + reactive queries.
 *
 * Methods:
 * - find(filter?) — Reactive query for multiple documents
 * - findOne(id) — Reactive query for a single document
 * - live(options?) — V2: reactive query with ordering and limits
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
        store.queryDocs(collection, filter).then(callback);
        const unsubscribe = store.onCollectionChange(collection, () => {
          store.queryDocs(collection, filter).then(callback);
        });
        return unsubscribe;
      },

      get: () => store.queryDocs(collection, filter),
    };
  }

  /**
   * V2: Live reactive query with ordering and limit support.
   *
   * ```ts
   * db.todos.live({
   *   where: { done: false },
   *   orderBy: 'createdAt',
   *   limit: 50
   * }).subscribe(todos => render(todos));
   * ```
   */
  live(options: LiveQueryOptions = {}): Query<Record<string, unknown>[]> {
    const collection = this.collection;
    const store = this.store;

    const executeQuery = async () => {
      let docs = await store.queryDocs(collection, options.where);
      if (options.orderBy) {
        docs.sort((a, b) => {
          const va = a[options.orderBy!];
          const vb = b[options.orderBy!];
          if (typeof va === 'number' && typeof vb === 'number') return va - vb;
          return String(va).localeCompare(String(vb));
        });
      }
      if (options.limit && docs.length > options.limit) {
        docs = docs.slice(0, options.limit);
      }
      return docs;
    };

    return {
      subscribe: (callback: Subscriber<Record<string, unknown>[]>): Unsubscribe => {
        executeQuery().then(callback);
        const unsubscribe = store.onCollectionChange(collection, () => {
          executeQuery().then(callback);
        });
        return unsubscribe;
      },
      get: () => executeQuery(),
    };
  }

  /**
   * Reactive query for a single document by ID.
   */
  findOne(id: string): Query<Record<string, unknown> | null> {
    const collection = this.collection;
    const store = this.store;

    return {
      subscribe: (callback: Subscriber<Record<string, unknown> | null>): Unsubscribe => {
        store.getDoc(collection, id).then(callback);
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

  async put(doc: Record<string, unknown>): Promise<void> {
    if (!doc.id) {
      doc.id = crypto.randomUUID();
    }
    const hlcTs = this.clock.now();
    const hlcStr = `${hlcTs.wallTime}-${hlcTs.counter.toString().padStart(4, '0')}-${hlcTs.nodeId}`;
    await this.store.putDoc(this.collection, doc, hlcStr, hlcTs.nodeId);
  }

  async update(id: string, fields: Record<string, unknown>): Promise<void> {
    const hlcTs = this.clock.now();
    const hlcStr = `${hlcTs.wallTime}-${hlcTs.counter.toString().padStart(4, '0')}-${hlcTs.nodeId}`;
    await this.store.updateDoc(this.collection, id, fields, hlcStr, hlcTs.nodeId);
  }

  async delete(id: string): Promise<void> {
    const hlcTs = this.clock.now();
    const hlcStr = `${hlcTs.wallTime}-${hlcTs.counter.toString().padStart(4, '0')}-${hlcTs.nodeId}`;
    await this.store.deleteDoc(this.collection, id, hlcStr, hlcTs.nodeId);
  }
}
