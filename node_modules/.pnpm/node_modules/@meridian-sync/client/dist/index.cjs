"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  CollectionProxy: () => CollectionProxy,
  DebugManager: () => DebugManager,
  MeridianStore: () => MeridianStore,
  PresenceManager: () => PresenceManager,
  SyncEngine: () => SyncEngine,
  TabCoordinator: () => TabCoordinator,
  createClient: () => createClient,
  defineSchema: () => import_shared3.defineSchema,
  z: () => import_shared3.z
});
module.exports = __toCommonJS(index_exports);

// src/client.ts
var import_shared2 = require("@meridian-sync/shared");

// src/store.ts
var import_idb = require("idb");
var import_shared = require("@meridian-sync/shared");
var DB_NAME_PREFIX = "meridian";
var META_STORE = "_meridian_meta";
var PENDING_STORE = "_meridian_pending";
var SYNC_STATE_STORE = "_meridian_sync";
var MeridianStore = class {
  db = null;
  config;
  changeListeners = /* @__PURE__ */ new Map();
  constructor(config) {
    this.config = config;
  }
  /**
   * Initialize IndexedDB — creates/upgrades stores as needed.
   */
  async init() {
    const { dbName, schema } = this.config;
    const collectionNames = Object.keys(schema.collections);
    this.db = await (0, import_idb.openDB)(`${DB_NAME_PREFIX}_${dbName}`, schema.version, {
      upgrade(db, oldVersion, newVersion) {
        for (const name of collectionNames) {
          if (!db.objectStoreNames.contains(name)) {
            db.createObjectStore(name, { keyPath: "id" });
          }
        }
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE);
        }
        if (!db.objectStoreNames.contains(PENDING_STORE)) {
          const store = db.createObjectStore(PENDING_STORE, { keyPath: "id" });
          store.createIndex("status", "status");
          store.createIndex("createdAt", "createdAt");
        }
        if (!db.objectStoreNames.contains(SYNC_STATE_STORE)) {
          db.createObjectStore(SYNC_STATE_STORE);
        }
      }
    });
  }
  ensureDB() {
    if (!this.db) {
      throw new Error("[Meridian Store] Database not initialized. Call init() first.");
    }
    return this.db;
  }
  // ─── Document Operations ───────────────────────────────────────────────────
  /**
   * Get a single document by ID.
   * Returns null if not found or soft-deleted.
   */
  async getDoc(collection, docId) {
    const db = this.ensureDB();
    const doc = await db.get(collection, docId);
    if (!doc) return null;
    const meta = await this.getMeta(collection, docId);
    if (meta && (0, import_shared.isDeleted)(meta)) return null;
    return doc;
  }
  /**
   * Get a document with its CRDT metadata.
   */
  async getDocWithMeta(collection, docId) {
    const db = this.ensureDB();
    const doc = await db.get(collection, docId);
    if (!doc) return null;
    const meta = await this.getMeta(collection, docId);
    if (!meta) return null;
    return { doc, crdtMap: meta };
  }
  /**
   * Put a document (create or update).
   * Writes both the document and CRDT metadata.
   *
   * @returns The pending operation created
   */
  async putDoc(collection, doc, hlc, nodeId) {
    const db = this.ensureDB();
    const docId = doc.id;
    const schema = this.config.schema.collections[collection];
    const pendingOps = [];
    if (schema) {
      const defaults = (0, import_shared.getDefaults)(schema);
      for (const [field, defaultValue] of Object.entries(defaults)) {
        if (!(field in doc) || doc[field] === void 0) {
          doc[field] = defaultValue;
        }
      }
    }
    const existingMeta = await this.getMeta(collection, docId);
    const newMap = (0, import_shared.createLWWMap)(doc, hlc, nodeId);
    let finalMap;
    if (existingMeta) {
      const { merged } = (0, import_shared.mergeLWWMaps)(existingMeta, newMap);
      finalMap = merged;
    } else {
      finalMap = newMap;
    }
    const tx = db.transaction([collection, META_STORE, PENDING_STORE], "readwrite");
    const values = (0, import_shared.extractValues)(finalMap);
    values.id = docId;
    await tx.objectStore(collection).put(values);
    await tx.objectStore(META_STORE).put(finalMap, `${collection}:${docId}`);
    for (const [field, value] of Object.entries(doc)) {
      if (field === "id") continue;
      const previousValue = existingMeta?.[field]?.value ?? null;
      const previousHlc = existingMeta?.[field]?.hlc ?? null;
      const pendingOp = {
        id: `${docId}-${field}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        op: {
          id: `${docId}-${field}-${hlc}`,
          collection,
          docId,
          field,
          value,
          hlc,
          nodeId
        },
        previousValue,
        previousHlc,
        status: "pending",
        createdAt: Date.now(),
        retries: 0
      };
      await tx.objectStore(PENDING_STORE).put(pendingOp);
      pendingOps.push(pendingOp);
    }
    await tx.done;
    this.notifyChange(collection, docId);
    return pendingOps;
  }
  /**
   * Update specific fields of a document.
   */
  async updateDoc(collection, docId, fields, hlc, nodeId) {
    const existing = await this.getDoc(collection, docId);
    if (!existing) {
      throw new Error(`[Meridian Store] Document "${docId}" not found in "${collection}".`);
    }
    const merged = { ...existing, ...fields, id: docId };
    return this.putDoc(collection, merged, hlc, nodeId);
  }
  /**
   * Soft-delete a document (tombstone).
   */
  async deleteDoc(collection, docId, hlc, nodeId) {
    const db = this.ensureDB();
    const existingMeta = await this.getMeta(collection, docId);
    if (!existingMeta) {
      return [];
    }
    const deleteMap = (0, import_shared.createLWWMap)({ [import_shared.DELETED_FIELD]: true }, hlc, nodeId);
    const { merged } = (0, import_shared.mergeLWWMaps)(existingMeta, deleteMap);
    const tx = db.transaction([collection, META_STORE, PENDING_STORE], "readwrite");
    await tx.objectStore(META_STORE).put(merged, `${collection}:${docId}`);
    await tx.objectStore(collection).delete(docId);
    const pendingOp = {
      id: `${docId}-${import_shared.DELETED_FIELD}-${Date.now()}`,
      op: {
        id: `${docId}-${import_shared.DELETED_FIELD}-${hlc}`,
        collection,
        docId,
        field: import_shared.DELETED_FIELD,
        value: true,
        hlc,
        nodeId
      },
      previousValue: false,
      previousHlc: existingMeta[import_shared.DELETED_FIELD]?.hlc ?? null,
      status: "pending",
      createdAt: Date.now(),
      retries: 0
    };
    await tx.objectStore(PENDING_STORE).put(pendingOp);
    await tx.done;
    this.notifyChange(collection, docId);
    return [pendingOp];
  }
  /**
   * Query all non-deleted documents in a collection.
   * Supports simple field-value filtering.
   */
  async queryDocs(collection, filter) {
    const db = this.ensureDB();
    const allDocs = await db.getAll(collection);
    const results = [];
    for (const doc of allDocs) {
      const docId = doc.id;
      if (filter) {
        let matches = true;
        for (const [key, value] of Object.entries(filter)) {
          if (doc[key] !== value) {
            matches = false;
            break;
          }
        }
        if (!matches) continue;
      }
      results.push(doc);
    }
    return results;
  }
  /**
   * Apply remote changes from server to local store.
   * Performs CRDT merge — only accepts changes with higher HLC.
   */
  async applyRemoteChanges(ops) {
    const db = this.ensureDB();
    const affectedDocs = /* @__PURE__ */ new Set();
    const grouped = /* @__PURE__ */ new Map();
    for (const op of ops) {
      const key = `${op.collection}:${op.docId}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(op);
    }
    for (const [key, docOps] of grouped) {
      const [collection, docId] = key.split(":");
      const remoteMap = {};
      for (const op of docOps) {
        remoteMap[op.field] = {
          value: op.value,
          hlc: op.hlc,
          nodeId: op.nodeId
        };
      }
      const existingMeta = await this.getMeta(collection, docId);
      let finalMap;
      if (existingMeta) {
        const { merged } = (0, import_shared.mergeLWWMaps)(existingMeta, remoteMap);
        finalMap = merged;
      } else {
        finalMap = remoteMap;
      }
      const tx = db.transaction([collection, META_STORE], "readwrite");
      if (!(0, import_shared.isDeleted)(finalMap)) {
        const values = (0, import_shared.extractValues)(finalMap);
        values.id = docId;
        await tx.objectStore(collection).put(values);
      } else {
        await tx.objectStore(collection).delete(docId);
      }
      await tx.objectStore(META_STORE).put(finalMap, key);
      await tx.done;
      affectedDocs.add(key);
      this.notifyChange(collection, docId);
    }
    return Array.from(affectedDocs);
  }
  // ─── CRDT Metadata ─────────────────────────────────────────────────────────
  async getMeta(collection, docId) {
    const db = this.ensureDB();
    return await db.get(META_STORE, `${collection}:${docId}`) ?? null;
  }
  // ─── Pending Operations ────────────────────────────────────────────────────
  /**
   * Get all pending operations (not yet acknowledged by server).
   */
  async getPendingOps() {
    const db = this.ensureDB();
    const all = await db.getAll(PENDING_STORE);
    return all.filter((op) => op.status === "pending" || op.status === "sending");
  }
  /**
   * Mark operations as sending (in-flight to server).
   */
  async markOpsSending(opIds) {
    const db = this.ensureDB();
    const tx = db.transaction(PENDING_STORE, "readwrite");
    for (const id of opIds) {
      const op = await tx.store.get(id);
      if (op) {
        op.status = "sending";
        op.retries++;
        await tx.store.put(op);
      }
    }
    await tx.done;
  }
  /**
   * Acknowledge operations (server confirmed persistence).
   */
  async ackOps(opIds) {
    const db = this.ensureDB();
    const tx = db.transaction(PENDING_STORE, "readwrite");
    for (const id of opIds) {
      await tx.store.delete(id);
    }
    await tx.done;
  }
  /**
   * Rollback rejected operations to their previous values.
   */
  async rollbackOp(opId) {
    const db = this.ensureDB();
    const pendingOp = await db.get(PENDING_STORE, opId);
    if (!pendingOp) return null;
    const { collection, docId, field } = pendingOp.op;
    if (pendingOp.previousHlc && pendingOp.previousValue !== null) {
      const meta = await this.getMeta(collection, docId);
      if (meta && meta[field]) {
        meta[field] = {
          value: pendingOp.previousValue,
          hlc: pendingOp.previousHlc,
          nodeId: meta[field].nodeId
        };
        const tx = db.transaction([collection, META_STORE, PENDING_STORE], "readwrite");
        await tx.objectStore(META_STORE).put(meta, `${collection}:${docId}`);
        const values = (0, import_shared.extractValues)(meta);
        values.id = docId;
        await tx.objectStore(collection).put(values);
        await tx.objectStore(PENDING_STORE).delete(opId);
        await tx.done;
        this.notifyChange(collection, docId);
      }
    } else {
      await db.delete(PENDING_STORE, opId);
    }
    return pendingOp;
  }
  /**
   * Reset all pending ops to 'pending' status (e.g., on reconnect).
   */
  async resetPendingStatus() {
    const db = this.ensureDB();
    const all = await db.getAll(PENDING_STORE);
    const tx = db.transaction(PENDING_STORE, "readwrite");
    for (const op of all) {
      if (op.status === "sending") {
        op.status = "pending";
        await tx.store.put(op);
      }
    }
    await tx.done;
  }
  // ─── Sync State ─────────────────────────────────────────────────────────────
  /**
   * Get the last known server sequence number.
   */
  async getLastSeq() {
    const db = this.ensureDB();
    return await db.get(SYNC_STATE_STORE, "lastSeq") ?? 0;
  }
  /**
   * Update the last known server sequence number.
   */
  async setLastSeq(seq) {
    const db = this.ensureDB();
    await db.put(SYNC_STATE_STORE, seq, "lastSeq");
  }
  // ─── Full Reset ─────────────────────────────────────────────────────────────
  /**
   * Clear all data (used for full re-sync after compaction gap).
   */
  async clearAll() {
    const db = this.ensureDB();
    const storeNames = Array.from(db.objectStoreNames);
    const tx = db.transaction(storeNames, "readwrite");
    for (const name of storeNames) {
      await tx.objectStore(name).clear();
    }
    await tx.done;
  }
  // ─── Change Listeners ──────────────────────────────────────────────────────
  /**
   * Register a listener for document changes in a collection.
   */
  onCollectionChange(collection, listener) {
    if (!this.changeListeners.has(collection)) {
      this.changeListeners.set(collection, /* @__PURE__ */ new Set());
    }
    this.changeListeners.get(collection).add(listener);
    return () => {
      this.changeListeners.get(collection)?.delete(listener);
    };
  }
  notifyChange(collection, docId) {
    const listeners = this.changeListeners.get(collection);
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(docId);
        } catch (e) {
          console.error("[Meridian Store] Change listener error:", e);
        }
      }
    }
  }
  // ─── Cleanup ───────────────────────────────────────────────────────────────
  /**
   * Close the database connection.
   */
  close() {
    this.db?.close();
    this.db = null;
    this.changeListeners.clear();
  }
};

// src/sync.ts
var INITIAL_RETRY_DELAY = 1e3;
var MAX_RETRY_DELAY = 3e4;
var HEARTBEAT_INTERVAL = 25e3;
var PUSH_BATCH_SIZE = 50;
var SyncEngine = class {
  ws = null;
  config;
  state = "disconnected";
  retryDelay = INITIAL_RETRY_DELAY;
  retryTimeout = null;
  heartbeatInterval = null;
  pushInProgress = false;
  destroyed = false;
  constructor(config) {
    this.config = config;
  }
  // ─── Connection Management ──────────────────────────────────────────────────
  /**
   * Start the sync engine — connect to server.
   */
  async start() {
    if (this.destroyed) return;
    if (typeof window !== "undefined") {
      window.addEventListener("online", this.handleOnline);
      window.addEventListener("offline", this.handleOffline);
    }
    await this.connect();
  }
  /**
   * Stop the sync engine — disconnect and clean up.
   */
  stop() {
    this.destroyed = true;
    this.clearRetry();
    this.clearHeartbeat();
    if (typeof window !== "undefined") {
      window.removeEventListener("online", this.handleOnline);
      window.removeEventListener("offline", this.handleOffline);
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.setState("disconnected");
  }
  /**
   * Force a manual sync cycle (push + pull).
   */
  async sync() {
    if (this.state !== "connected") {
      this.log("\u26A0\uFE0F Cannot sync \u2014 not connected");
      return;
    }
    await this.pushPendingOps();
    await this.pullChanges();
  }
  /**
   * Check if connected.
   */
  get isConnected() {
    return this.state === "connected";
  }
  /**
   * Current connection state.
   */
  get connectionState() {
    return this.state;
  }
  // ─── Internal Connection ────────────────────────────────────────────────────
  async connect() {
    if (this.destroyed || this.ws) return;
    this.setState("connecting");
    try {
      this.ws = new WebSocket(this.config.serverUrl);
      this.ws.onopen = async () => {
        this.log("\u{1F50C} WebSocket connected");
        this.retryDelay = INITIAL_RETRY_DELAY;
        this.startHeartbeat();
        if (this.config.auth) {
          this.setState("authenticating");
          const token = await this.config.auth.getToken();
          this.send({
            type: "auth",
            token,
            schemaVersion: this.config.schemaVersion
          });
        } else {
          this.setState("connected");
          await this.config.store.resetPendingStatus();
          await this.sync();
        }
      };
      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          this.handleMessage(msg);
        } catch (e) {
          this.log("\u274C Failed to parse message:", e);
        }
      };
      this.ws.onerror = (event) => {
        this.log("\u274C WebSocket error");
      };
      this.ws.onclose = () => {
        this.log("\u{1F50C} WebSocket closed");
        this.ws = null;
        this.clearHeartbeat();
        this.setState("disconnected");
        if (!this.destroyed) {
          this.scheduleReconnect();
        }
      };
    } catch (e) {
      this.log("\u274C Connection failed:", e);
      this.ws = null;
      this.setState("disconnected");
      if (!this.destroyed) {
        this.scheduleReconnect();
      }
    }
  }
  scheduleReconnect() {
    this.clearRetry();
    this.log(`\u23F3 Reconnecting in ${this.retryDelay}ms...`);
    this.retryTimeout = setTimeout(() => {
      this.retryTimeout = null;
      this.connect();
    }, this.retryDelay);
    this.retryDelay = Math.min(
      this.retryDelay * 2 + Math.random() * 1e3,
      MAX_RETRY_DELAY
    );
  }
  clearRetry() {
    if (this.retryTimeout) {
      clearTimeout(this.retryTimeout);
      this.retryTimeout = null;
    }
  }
  // ─── Heartbeat ──────────────────────────────────────────────────────────────
  startHeartbeat() {
    this.clearHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send("ping");
      }
    }, HEARTBEAT_INTERVAL);
  }
  clearHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }
  // ─── Message Handling ───────────────────────────────────────────────────────
  async handleMessage(msg) {
    switch (msg.type) {
      case "ack":
        await this.handleAck(msg);
        break;
      case "reject":
        await this.handleReject(msg);
        break;
      case "changes":
        await this.handleChanges(msg);
        break;
      case "full-sync-required":
        await this.handleFullSyncRequired(msg);
        break;
      case "auth-expiring":
        await this.handleAuthExpiring(msg);
        break;
      case "auth-expired":
        this.log("\u{1F512} Auth expired \u2014 disconnecting");
        this.ws?.close();
        break;
      case "auth-ack":
        this.log("\u{1F513} Auth successful");
        this.setState("connected");
        await this.config.store.resetPendingStatus();
        await this.sync();
        break;
      case "presence":
        break;
      case "compaction":
        this.log(`\u{1F9F9} Compaction: minSeq=${msg.minSeq}`);
        break;
      case "error":
        this.log(`\u274C Server error [${msg.code}]: ${msg.message}`);
        break;
    }
  }
  async handleAck(msg) {
    this.log(`\u2705 Ack: ${msg.opIds.length} ops confirmed, lastSeq=${msg.lastSeq}`);
    await this.config.store.ackOps(msg.opIds);
    await this.config.store.setLastSeq(msg.lastSeq);
  }
  async handleReject(msg) {
    this.log(`\u274C Reject: op=${msg.opId} code=${msg.code} reason=${msg.reason}`);
    const rolledBack = await this.config.store.rollbackOp(msg.opId);
    if (rolledBack && this.config.onRollback) {
      this.config.onRollback(rolledBack, msg.reason);
    }
  }
  async handleChanges(msg) {
    if (msg.changes.length === 0) return;
    this.setState("syncing");
    this.log(`\u2B07\uFE0F Received ${msg.changes.length} changes`);
    const ops = msg.changes.map((c) => c.op);
    await this.config.store.applyRemoteChanges(ops);
    const maxSeq = Math.max(...msg.changes.map((c) => c.seq));
    await this.config.store.setLastSeq(maxSeq);
    this.setState("connected");
  }
  async handleFullSyncRequired(msg) {
    this.log(`\u{1F504} Full re-sync required: ${msg.reason} (minSeq=${msg.minSeq})`);
    await this.config.store.clearAll();
    await this.pullChanges();
  }
  async handleAuthExpiring(msg) {
    this.log(`\u{1F511} Auth expiring in ${msg.expiresIn}s \u2014 refreshing`);
    if (this.config.auth) {
      try {
        const newToken = await this.config.auth.getToken();
        this.send({ type: "auth", token: newToken });
        this.log("\u{1F511} Auth refreshed");
      } catch (e) {
        this.log("\u274C Auth refresh failed:", e);
      }
    }
  }
  // ─── Push / Pull ────────────────────────────────────────────────────────────
  /**
   * Push all pending operations to the server.
   */
  async pushPendingOps() {
    if (this.pushInProgress || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.pushInProgress = true;
    try {
      const pendingOps = await this.config.store.getPendingOps();
      if (pendingOps.length === 0) {
        return;
      }
      this.log(`\u2B06\uFE0F Pushing ${pendingOps.length} pending ops`);
      for (let i = 0; i < pendingOps.length; i += PUSH_BATCH_SIZE) {
        const batch = pendingOps.slice(i, i + PUSH_BATCH_SIZE);
        const opIds = batch.map((p) => p.id);
        await this.config.store.markOpsSending(opIds);
        this.send({
          type: "push",
          ops: batch.map((p) => p.op)
        });
      }
    } finally {
      this.pushInProgress = false;
    }
  }
  /**
   * Pull changes from server since last known seqNum.
   */
  async pullChanges() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const lastSeq = await this.config.store.getLastSeq();
    this.log(`\u2B07\uFE0F Pulling changes since seq=${lastSeq}`);
    this.send({
      type: "pull",
      since: lastSeq
    });
  }
  // ─── Online/Offline ─────────────────────────────────────────────────────────
  handleOnline = () => {
    this.log("\u{1F310} Online \u2014 reconnecting");
    if (!this.ws && !this.destroyed) {
      this.retryDelay = INITIAL_RETRY_DELAY;
      this.connect();
    }
  };
  handleOffline = () => {
    this.log("\u{1F4F4} Offline");
    this.clearRetry();
    this.setState("disconnected");
  };
  // ─── Utilities ──────────────────────────────────────────────────────────────
  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
  setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.config.onConnectionChange?.(state);
  }
  log(...args) {
    if (this.config.debug) {
      console.log("[Meridian]", ...args);
    }
  }
};

// src/reactive.ts
var CollectionProxy = class {
  collection;
  store;
  clock;
  constructor(collection, store, clock) {
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
  find(filter) {
    const collection = this.collection;
    const store = this.store;
    return {
      subscribe: (callback) => {
        store.queryDocs(collection, filter).then(callback);
        const unsubscribe = store.onCollectionChange(collection, () => {
          store.queryDocs(collection, filter).then(callback);
        });
        return unsubscribe;
      },
      get: () => store.queryDocs(collection, filter)
    };
  }
  /**
   * Reactive query for a single document by ID.
   *
   * @param id - Document ID
   * @returns Query object with subscribe() and get()
   */
  findOne(id) {
    const collection = this.collection;
    const store = this.store;
    return {
      subscribe: (callback) => {
        store.getDoc(collection, id).then(callback);
        const unsubscribe = store.onCollectionChange(collection, (docId) => {
          if (docId === id) {
            store.getDoc(collection, id).then(callback);
          }
        });
        return unsubscribe;
      },
      get: () => store.getDoc(collection, id)
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
  async put(doc) {
    if (!doc.id) {
      doc.id = crypto.randomUUID();
    }
    const hlcTs = this.clock.now();
    const hlcStr = `${hlcTs.wallTime}-${hlcTs.counter.toString().padStart(4, "0")}-${hlcTs.nodeId}`;
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
  async update(id, fields) {
    const hlcTs = this.clock.now();
    const hlcStr = `${hlcTs.wallTime}-${hlcTs.counter.toString().padStart(4, "0")}-${hlcTs.nodeId}`;
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
  async delete(id) {
    const hlcTs = this.clock.now();
    const hlcStr = `${hlcTs.wallTime}-${hlcTs.counter.toString().padStart(4, "0")}-${hlcTs.nodeId}`;
    await this.store.deleteDoc(this.collection, id, hlcStr, hlcTs.nodeId);
  }
};

// src/tab-coordinator.ts
var CHANNEL_NAME = "meridian-sync";
var HEARTBEAT_INTERVAL2 = 2e3;
var HEARTBEAT_TIMEOUT = 3e3;
var globalLockCounter = 0;
var TabCoordinator = class {
  channel = null;
  tabId;
  lockId;
  config;
  role = "follower";
  heartbeatInterval = null;
  heartbeatTimeout = null;
  destroyed = false;
  constructor(config) {
    this.config = config;
    this.lockId = ++globalLockCounter;
    this.tabId = `tab-${this.lockId}-${Math.random().toString(36).slice(2, 6)}`;
  }
  /**
   * Start the coordinator and participate in leader election.
   */
  start() {
    if (typeof BroadcastChannel === "undefined") {
      this.log("\u26A0\uFE0F BroadcastChannel not available \u2014 assuming leader");
      this.becomeLeader();
      return;
    }
    this.channel = new BroadcastChannel(CHANNEL_NAME);
    this.channel.onmessage = (event) => this.handleMessage(event.data);
    if (typeof window !== "undefined") {
      window.addEventListener("beforeunload", this.handleBeforeUnload);
    }
    this.claimLeadership();
  }
  /**
   * Stop the coordinator.
   */
  stop() {
    this.destroyed = true;
    if (this.role === "leader") {
      this.broadcast({ type: "leader-resign", tabId: this.tabId });
    }
    this.clearHeartbeat();
    this.clearHeartbeatTimeout();
    if (typeof window !== "undefined") {
      window.removeEventListener("beforeunload", this.handleBeforeUnload);
    }
    this.channel?.close();
    this.channel = null;
  }
  /**
   * Current tab role.
   */
  get currentRole() {
    return this.role;
  }
  /**
   * Whether this tab is the leader.
   */
  get isLeader() {
    return this.role === "leader";
  }
  /**
   * Broadcast a store change event to other tabs.
   * Called by the leader after writing to IndexedDB.
   */
  broadcastStoreChange(collection, docId) {
    this.broadcast({ type: "store-changed", collection, docId });
  }
  // ─── Internal ──────────────────────────────────────────────────────────────
  claimLeadership() {
    this.log(`\u{1F4CB} Claiming leadership (lockId=${this.lockId})`);
    this.broadcast({ type: "claim-leader", tabId: this.tabId, lockId: this.lockId });
    setTimeout(() => {
      if (!this.destroyed && this.role === "follower") {
        this.becomeLeader();
      }
    }, 200);
  }
  becomeLeader() {
    if (this.role === "leader") return;
    this.log("\u{1F451} Became leader");
    this.role = "leader";
    this.clearHeartbeatTimeout();
    this.startHeartbeat();
    this.config.onBecomeLeader();
  }
  becomeFollower() {
    if (this.role === "follower") return;
    this.log("\u{1F464} Became follower");
    this.role = "follower";
    this.clearHeartbeat();
    this.startHeartbeatTimeout();
    this.config.onBecomeFollower();
  }
  handleMessage(msg) {
    switch (msg.type) {
      case "leader-resign":
        if (this.role === "follower") {
          this.log(`\u{1F451} Leader resigned (${msg.tabId}) \u2014 claiming`);
          this.claimLeadership();
        }
        break;
      case "claim-leader":
        if (this.role === "leader") {
          this.broadcast({ type: "leader-ack", tabId: this.tabId });
        } else if (msg.lockId < this.lockId) {
        }
        break;
      case "leader-ack":
        if (msg.tabId !== this.tabId) {
          this.becomeFollower();
          this.resetHeartbeatTimeout();
        }
        break;
      case "leader-heartbeat":
        if (msg.tabId !== this.tabId) {
          if (this.role === "leader") {
            this.becomeFollower();
          }
          this.resetHeartbeatTimeout();
        }
        break;
      case "store-changed":
        this.config.onRemoteStoreChange(msg.collection, msg.docId);
        break;
      case "request-sync":
        if (this.role === "leader") {
        }
        break;
    }
  }
  handleBeforeUnload = () => {
    if (this.role === "leader") {
      this.broadcast({ type: "leader-resign", tabId: this.tabId });
    }
  };
  // ─── Heartbeat ──────────────────────────────────────────────────────────────
  startHeartbeat() {
    this.clearHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      this.broadcast({ type: "leader-heartbeat", tabId: this.tabId });
    }, HEARTBEAT_INTERVAL2);
  }
  clearHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }
  startHeartbeatTimeout() {
    this.resetHeartbeatTimeout();
  }
  resetHeartbeatTimeout() {
    this.clearHeartbeatTimeout();
    this.heartbeatTimeout = setTimeout(() => {
      this.log("\u23F0 Leader heartbeat timeout \u2014 re-electing");
      this.claimLeadership();
    }, HEARTBEAT_TIMEOUT);
  }
  clearHeartbeatTimeout() {
    if (this.heartbeatTimeout) {
      clearTimeout(this.heartbeatTimeout);
      this.heartbeatTimeout = null;
    }
  }
  // ─── Utilities ──────────────────────────────────────────────────────────────
  broadcast(msg) {
    try {
      this.channel?.postMessage(msg);
    } catch (e) {
    }
  }
  log(...args) {
    if (this.config.debug) {
      console.log(`[Meridian Tab:${this.tabId}]`, ...args);
    }
  }
};

// src/presence.ts
var PresenceManager = class {
  localPresence = null;
  peers = {};
  listeners = /* @__PURE__ */ new Set();
  sendFn = null;
  /**
   * Set the function used to send presence over WebSocket.
   */
  setSendFunction(fn) {
    this.sendFn = fn;
  }
  /**
   * Set local presence data and broadcast to peers.
   *
   * Usage:
   * ```ts
   * db.presence.set({ cursor: { x: 100, y: 200 }, name: 'Alice' });
   * ```
   */
  set(data) {
    this.localPresence = data;
    this.sendFn?.(data);
  }
  /**
   * Subscribe to presence updates from all connected peers.
   *
   * Usage:
   * ```ts
   * db.presence.subscribe((peers) => {
   *   // peers: { "user-1": { cursor: {...}, name: "Bob" }, ... }
   *   renderCursors(peers);
   * });
   * ```
   */
  subscribe(callback) {
    this.listeners.add(callback);
    callback({ ...this.peers });
    return () => {
      this.listeners.delete(callback);
    };
  }
  /**
   * Handle presence broadcast from server.
   * Called by the sync engine when a presence message arrives.
   */
  handleServerPresence(peers) {
    this.peers = peers;
    this.notifyListeners();
  }
  /**
   * Re-send local presence after reconnect.
   * Called by the sync engine when WebSocket reconnects.
   */
  resendPresence() {
    if (this.localPresence) {
      this.sendFn?.(this.localPresence);
    }
  }
  /**
   * Clear all presence data.
   */
  clear() {
    this.localPresence = null;
    this.peers = {};
    this.listeners.clear();
    this.sendFn = null;
  }
  notifyListeners() {
    const snapshot = { ...this.peers };
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (e) {
        console.error("[Meridian Presence] Listener error:", e);
      }
    }
  }
};

// src/debug.ts
var DebugManager = class {
  store;
  conflictHistory = [];
  connectionState = "disconnected";
  lastSyncTime = null;
  maxConflictHistory = 100;
  constructor(store) {
    this.store = store;
  }
  /**
   * Get all pending operations (not yet confirmed by server).
   */
  async getPendingOps() {
    return this.store.getPendingOps();
  }
  /**
   * Get the last known server sequence number.
   */
  async getLastSyncSeq() {
    return this.store.getLastSeq();
  }
  /**
   * Get the conflict history (limited to last 100 entries).
   */
  getConflictHistory() {
    return [...this.conflictHistory];
  }
  /**
   * Get the current connection state.
   */
  getConnectionState() {
    return this.connectionState;
  }
  /**
   * Get the timestamp of the last successful sync.
   */
  getLastSyncTime() {
    return this.lastSyncTime;
  }
  // ─── Internal Updates ──────────────────────────────────────────────────────
  /** @internal */
  addConflict(conflict) {
    this.conflictHistory.push(conflict);
    if (this.conflictHistory.length > this.maxConflictHistory) {
      this.conflictHistory.shift();
    }
  }
  /** @internal */
  updateConnectionState(state) {
    this.connectionState = state;
  }
  /** @internal */
  markSynced() {
    this.lastSyncTime = Date.now();
  }
};

// src/client.ts
function createClient(config) {
  const {
    schema,
    serverUrl,
    auth,
    dbName = simpleHash(serverUrl),
    debug = false,
    onRollback,
    onConnectionChange
  } = config;
  const nodeId = (0, import_shared2.generateNodeId)();
  const clock = new import_shared2.HLC(nodeId);
  const store = new MeridianStore({ dbName, schema, nodeId });
  const debugManager = new DebugManager(store);
  const presence = new PresenceManager();
  const syncEngine = new SyncEngine({
    serverUrl,
    store,
    auth,
    schemaVersion: schema.version,
    debug,
    onConnectionChange: (state) => {
      debugManager.updateConnectionState(state);
      if (state === "connected") {
        debugManager.markSynced();
        presence.resendPresence();
      }
      onConnectionChange?.(state);
    },
    onRollback
  });
  const tabCoordinator = new TabCoordinator({
    debug,
    onBecomeLeader: () => {
      if (debug) console.log("[Meridian] \u{1F451} This tab is now the leader");
      syncEngine.start();
    },
    onBecomeFollower: () => {
      if (debug) console.log("[Meridian] \u{1F464} This tab is now a follower");
      syncEngine.stop();
    },
    onRemoteStoreChange: (collection, docId) => {
      store.notifyChange(collection, docId);
    }
  });
  presence.setSendFunction((data) => {
    if (syncEngine.isConnected) {
      syncEngine.send({
        type: "presence",
        data
      });
    }
  });
  const collections = {};
  for (const name of Object.keys(schema.collections)) {
    collections[name] = new CollectionProxy(name, store, clock);
  }
  const client = {
    get connectionState() {
      return syncEngine.connectionState;
    },
    presence,
    debug: debugManager,
    async sync() {
      await syncEngine.sync();
    },
    destroy() {
      tabCoordinator.stop();
      syncEngine.stop();
      presence.clear();
      store.close();
    },
    ...collections
  };
  (async () => {
    try {
      await store.init();
      tabCoordinator.start();
      if (debug) {
        console.log(`[Meridian] \u{1F680} Client initialized`);
        console.log(`[Meridian] \u{1F4CB} Node ID: ${nodeId}`);
        console.log(`[Meridian] \u{1F4E6} Collections: ${Object.keys(schema.collections).join(", ")}`);
        console.log(`[Meridian] \u{1F517} Server: ${serverUrl}`);
      }
    } catch (e) {
      console.error("[Meridian] \u274C Initialization failed:", e);
    }
  })();
  return client;
}
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

// src/index.ts
var import_shared3 = require("@meridian-sync/shared");
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CollectionProxy,
  DebugManager,
  MeridianStore,
  PresenceManager,
  SyncEngine,
  TabCoordinator,
  createClient,
  defineSchema,
  z
});
