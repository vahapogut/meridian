"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  CompactionManager: () => CompactionManager,
  MergeEngine: () => MergeEngine,
  PgStore: () => PgStore,
  ServerPresenceManager: () => ServerPresenceManager,
  WsHub: () => WsHub,
  createServer: () => createServer,
  defineSchema: () => import_shared2.defineSchema,
  z: () => import_shared2.z
});
module.exports = __toCommonJS(index_exports);

// src/pg-store.ts
var import_pg = __toESM(require("pg"), 1);
var import_shared = require("@meridian-sync/shared");
var { Pool } = import_pg.default;
var PgStore = class {
  pool;
  config;
  changeCallbacks = /* @__PURE__ */ new Set();
  listenClient = null;
  minSeq = 0;
  constructor(config) {
    this.config = config;
    this.pool = new Pool({ connectionString: config.connectionString });
  }
  /**
   * Initialize the database — create tables, sequences, triggers.
   */
  async init() {
    await this.pool.query(`
      CREATE SEQUENCE IF NOT EXISTS meridian_seq;
    `);
    for (const [name, fields] of Object.entries(this.config.schema.collections)) {
      await this.createTable(name, fields);
    }
    await this.startListening();
    await this.updateMinSeq();
  }
  /**
   * Get the table name with optional namespace prefix.
   */
  tableName(collection) {
    return this.config.namespace ? `${this.config.namespace}_${collection}` : collection;
  }
  /**
   * Create a table for a collection with Meridian system columns.
   */
  async createTable(collection, fields) {
    const table = this.tableName(collection);
    const tableExistsResult = await this.pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = $1
      );
    `, [table]);
    const tableExists = tableExistsResult.rows[0].exists;
    if (!tableExists) {
      const columns = ["id TEXT PRIMARY KEY"];
      for (const [name, def] of Object.entries(fields)) {
        if (name === "id") continue;
        const sqlType = (0, import_shared.fieldTypeToSQL)(def.type);
        columns.push(`${name} ${sqlType}`);
      }
      columns.push(`_meridian_meta JSONB DEFAULT '{}'::jsonb`);
      columns.push(`_meridian_seq BIGINT DEFAULT nextval('meridian_seq')`);
      columns.push(`_meridian_deleted BOOLEAN DEFAULT false`);
      columns.push(`_meridian_updated_at TEXT`);
      await this.pool.query(`
        CREATE TABLE ${table} (
          ${columns.join(",\n          ")}
        );
      `);
      await this.pool.query(`
        CREATE INDEX idx_${table}_seq ON ${table}(_meridian_seq);
      `);
    } else {
      const colsResult = await this.pool.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = $1
      `, [table]);
      const existingColumns = new Set(colsResult.rows.map((r) => r.column_name));
      for (const [name, def] of Object.entries(fields)) {
        if (name === "id" || existingColumns.has(name)) continue;
        const sqlType = (0, import_shared.fieldTypeToSQL)(def.type);
        await this.pool.query(`
          ALTER TABLE ${table} ADD COLUMN ${name} ${sqlType};
        `);
      }
    }
    await this.pool.query(`
      CREATE OR REPLACE FUNCTION meridian_notify_${table}() RETURNS trigger AS $$
      BEGIN
        PERFORM pg_notify('meridian_changes', json_build_object(
          'table', '${collection}',
          'id', NEW.id,
          'op', TG_OP
        )::text);
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await this.pool.query(`
      DROP TRIGGER IF EXISTS meridian_trigger_${table} ON ${table};
      CREATE TRIGGER meridian_trigger_${table}
        AFTER INSERT OR UPDATE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION meridian_notify_${table}();
    `);
  }
  // ─── CRDT Operations ───────────────────────────────────────────────────────
  /**
   * Apply CRDT operations from a client.
   * Performs field-level LWW merge with existing data.
   * @returns Array of server changes with assigned sequence numbers and any conflicts
   */
  async applyOperations(ops) {
    const client = await this.pool.connect();
    const changes = [];
    const allConflicts = [];
    try {
      await client.query("BEGIN");
      const grouped = /* @__PURE__ */ new Map();
      for (const op of ops) {
        const key = `${op.collection}:${op.docId}`;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(op);
      }
      for (const [key, docOps] of grouped) {
        const firstColon = key.indexOf(":");
        const collection = key.slice(0, firstColon);
        const docId = key.slice(firstColon + 1);
        const table = this.tableName(collection);
        const existing = await client.query(
          `SELECT * FROM ${table} WHERE id = $1 FOR UPDATE`,
          [docId]
        );
        const remoteMap = {};
        for (const op of docOps) {
          remoteMap[op.field] = {
            value: op.value,
            hlc: op.hlc,
            nodeId: op.nodeId
          };
        }
        let finalMap;
        if (existing.rows.length > 0) {
          const row = existing.rows[0];
          const existingMeta = row._meridian_meta || {};
          const existingMap = (0, import_shared.reconstructLWWMap)(row, existingMeta);
          const { merged, conflicts } = (0, import_shared.mergeLWWMaps)(existingMap, remoteMap);
          finalMap = merged;
          if (conflicts.length > 0) {
            allConflicts.push(...conflicts);
          }
        } else {
          finalMap = remoteMap;
        }
        const values = (0, import_shared.extractValues)(finalMap);
        const metadata = (0, import_shared.extractMetadata)(finalMap);
        const latestHlc = (0, import_shared.getLatestHLC)(finalMap);
        const deleted = (0, import_shared.isDeleted)(finalMap);
        const fields = Object.keys(this.config.schema.collections[collection] || {}).filter((f) => f !== "id");
        if (existing.rows.length > 0) {
          const setClauses = [];
          const params = [];
          let paramIdx = 1;
          for (const field of fields) {
            if (field in values) {
              setClauses.push(`${field} = $${paramIdx}`);
              params.push(values[field]);
              paramIdx++;
            }
          }
          setClauses.push(`_meridian_meta = $${paramIdx}`);
          params.push(JSON.stringify(metadata));
          paramIdx++;
          setClauses.push(`_meridian_deleted = $${paramIdx}`);
          params.push(deleted);
          paramIdx++;
          setClauses.push(`_meridian_updated_at = $${paramIdx}`);
          params.push(latestHlc);
          paramIdx++;
          setClauses.push(`_meridian_seq = nextval('meridian_seq')`);
          params.push(docId);
          const result = await client.query(
            `UPDATE ${table} SET ${setClauses.join(", ")} WHERE id = $${paramIdx} RETURNING _meridian_seq`,
            params
          );
          const seq = Number(result.rows[0]._meridian_seq);
          for (const op of docOps) {
            changes.push({ seq, op });
          }
        } else {
          const insertFields = ["id"];
          const insertValues = [docId];
          const placeholders = ["$1"];
          let paramIdx = 2;
          for (const field of fields) {
            if (field in values) {
              insertFields.push(field);
              insertValues.push(values[field]);
              placeholders.push(`$${paramIdx}`);
              paramIdx++;
            }
          }
          insertFields.push("_meridian_meta");
          insertValues.push(JSON.stringify(metadata));
          placeholders.push(`$${paramIdx}`);
          paramIdx++;
          insertFields.push("_meridian_deleted");
          insertValues.push(deleted);
          placeholders.push(`$${paramIdx}`);
          paramIdx++;
          insertFields.push("_meridian_updated_at");
          insertValues.push(latestHlc);
          placeholders.push(`$${paramIdx}`);
          const result = await client.query(
            `INSERT INTO ${table} (${insertFields.join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING _meridian_seq`,
            insertValues
          );
          const seq = Number(result.rows[0]._meridian_seq);
          for (const op of docOps) {
            changes.push({ seq, op });
          }
        }
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    return { changes, conflicts: allConflicts };
  }
  /**
   * Get all changes since a given sequence number.
   * Used for pull protocol.
   *
   * @returns null if seqNum is below minSeq (compaction gap), otherwise changes
   */
  async getChangesSince(since) {
    if (since > 0 && since < this.minSeq) {
      return null;
    }
    const changes = [];
    for (const collection of Object.keys(this.config.schema.collections)) {
      const table = this.tableName(collection);
      const fields = Object.keys(this.config.schema.collections[collection]).filter((f) => f !== "id");
      const result = await this.pool.query(
        `SELECT * FROM ${table} WHERE _meridian_seq > $1 ORDER BY _meridian_seq ASC`,
        [since]
      );
      for (const row of result.rows) {
        const meta = row._meridian_meta || {};
        const seq = Number(row._meridian_seq);
        for (const field of fields) {
          if (field in row && row[field] !== void 0) {
            const hlc = meta[field] || `0-0000-server`;
            changes.push({
              seq,
              op: {
                id: `${row.id}-${field}-${hlc}`,
                collection,
                docId: row.id,
                field,
                value: row[field],
                hlc,
                nodeId: "server"
              }
            });
          }
        }
        if (row._meridian_deleted) {
          const hlc = meta[import_shared.DELETED_FIELD] || `0-0000-server`;
          changes.push({
            seq,
            op: {
              id: `${row.id}-${import_shared.DELETED_FIELD}-${hlc}`,
              collection,
              docId: row.id,
              field: import_shared.DELETED_FIELD,
              value: true,
              hlc,
              nodeId: "server"
            }
          });
        }
      }
    }
    changes.sort((a, b) => a.seq - b.seq);
    return changes;
  }
  /**
   * Get the current minimum available sequence number.
   */
  getMinSeq() {
    return this.minSeq;
  }
  // ─── Compaction ─────────────────────────────────────────────────────────────
  /**
   * Delete tombstoned rows older than maxAge.
   * @returns Number of rows deleted
   */
  async compact(maxAgeMs) {
    let totalDeleted = 0;
    const cutoffTime = Date.now() - maxAgeMs;
    for (const collection of Object.keys(this.config.schema.collections)) {
      const table = this.tableName(collection);
      const result = await this.pool.query(
        `DELETE FROM ${table} WHERE _meridian_deleted = true AND 
         CAST(SPLIT_PART(_meridian_updated_at, '-', 1) AS BIGINT) < $1`,
        [cutoffTime]
      );
      totalDeleted += result.rowCount ?? 0;
    }
    await this.updateMinSeq();
    return totalDeleted;
  }
  async updateMinSeq() {
    let minSeq = Infinity;
    for (const collection of Object.keys(this.config.schema.collections)) {
      const table = this.tableName(collection);
      try {
        const result = await this.pool.query(
          `SELECT MIN(_meridian_seq) as min_seq FROM ${table}`
        );
        if (result.rows[0]?.min_seq !== null) {
          minSeq = Math.min(minSeq, Number(result.rows[0].min_seq));
        }
      } catch {
      }
    }
    this.minSeq = minSeq === Infinity ? 0 : minSeq;
  }
  // ─── LISTEN/NOTIFY ──────────────────────────────────────────────────────────
  async startListening() {
    this.listenClient = await this.pool.connect();
    this.listenClient.on("notification", (msg) => {
      if (msg.channel === "meridian_changes" && msg.payload) {
        try {
          const data = JSON.parse(msg.payload);
          for (const cb of this.changeCallbacks) {
            cb(data.table, data.id);
          }
        } catch (e) {
          console.error("[Meridian PgStore] Failed to parse notification:", e);
        }
      }
    });
    await this.listenClient.query("LISTEN meridian_changes");
  }
  /**
   * Register a callback for database changes.
   */
  onChange(callback) {
    this.changeCallbacks.add(callback);
    return () => this.changeCallbacks.delete(callback);
  }
  // ─── Cleanup ───────────────────────────────────────────────────────────────
  /**
   * Close the database connection pool.
   */
  async close() {
    if (this.listenClient) {
      this.listenClient.release();
      this.listenClient = null;
    }
    await this.pool.end();
  }
};

// src/ws-hub.ts
var import_ws = require("ws");
var HEARTBEAT_INTERVAL = 3e4;
var AUTH_EXPIRY_WARNING = 5 * 60 * 1e3;
var AUTH_CHECK_INTERVAL = 6e4;
var WsHub = class {
  wss = null;
  config;
  clients = /* @__PURE__ */ new Map();
  heartbeatInterval = null;
  authCheckInterval = null;
  constructor(config) {
    this.config = config;
  }
  /**
   * Start the WebSocket server.
   */
  start() {
    const { port, path = "/sync" } = this.config;
    this.wss = new import_ws.WebSocketServer({ port, path });
    this.wss.on("connection", (ws, req) => {
      this.handleConnection(ws, req);
    });
    this.startHeartbeat();
    this.startAuthCheck();
    this.log(`\u{1F50C} WebSocket server listening on ws://localhost:${port}${path}`);
  }
  /**
   * Stop the WebSocket server.
   */
  stop() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.authCheckInterval) {
      clearInterval(this.authCheckInterval);
      this.authCheckInterval = null;
    }
    for (const client of this.clients.values()) {
      client.ws.close();
    }
    this.clients.clear();
    this.wss?.close();
    this.wss = null;
  }
  // ─── Connection Handling ────────────────────────────────────────────────────
  handleConnection(ws, req) {
    const clientId = `client-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const client = {
      id: clientId,
      ws,
      userId: null,
      namespace: null,
      subscribedCollections: /* @__PURE__ */ new Set(),
      authExpiresAt: null,
      lastActivity: Date.now()
    };
    this.clients.set(clientId, client);
    this.log(`\u{1F517} Client connected: ${clientId}`);
    ws.on("message", async (data) => {
      client.lastActivity = Date.now();
      const raw = data.toString();
      if (raw === "ping") {
        ws.send("pong");
        return;
      }
      try {
        const msg = JSON.parse(raw);
        await this.handleClientMessage(clientId, msg, client);
      } catch (e) {
        this.sendTo(client, {
          type: "error",
          code: "PARSE_ERROR",
          message: "Failed to parse message"
        });
      }
    });
    ws.on("close", () => {
      this.log(`\u{1F50C} Client disconnected: ${clientId}`);
      this.clients.delete(clientId);
      this.config.onDisconnect?.(clientId);
    });
    ws.on("error", (err) => {
      this.log(`\u274C Client error (${clientId}):`, err.message);
    });
  }
  async handleClientMessage(clientId, msg, client) {
    if (msg.type === "auth") {
      if (this.config.auth) {
        try {
          const result = await this.config.auth(msg.token);
          client.userId = result.userId;
          client.namespace = result.namespace ?? null;
          client.authExpiresAt = result.expiresAt ?? null;
          this.log(`\u{1F511} Client ${clientId} authenticated as ${result.userId}`);
          this.sendTo(client, { type: "auth-ack" });
        } catch (e) {
          this.sendTo(client, {
            type: "error",
            code: "AUTH_FAILED",
            message: e instanceof Error ? e.message : "Authentication failed"
          });
          client.ws.close();
          return;
        }
      }
      return;
    }
    if (this.config.auth && !client.userId) {
      this.sendTo(client, {
        type: "error",
        code: "AUTH_REQUIRED",
        message: "Authentication required. Send an auth message first."
      });
      return;
    }
    if (msg.type === "subscribe") {
      for (const collection of msg.collections) {
        client.subscribedCollections.add(collection);
      }
      this.log(`\u{1F4CB} Client ${clientId} subscribed to: ${msg.collections.join(", ")}`);
      return;
    }
    this.config.onMessage(clientId, msg, client);
  }
  // ─── Broadcasting ──────────────────────────────────────────────────────────
  /**
   * Send a message to a specific client.
   */
  sendTo(client, msg) {
    if (client.ws.readyState === import_ws.WebSocket.OPEN) {
      client.ws.send(JSON.stringify(msg));
    }
  }
  /**
   * Send a message to a client by ID.
   */
  sendToId(clientId, msg) {
    const client = this.clients.get(clientId);
    if (client) {
      this.sendTo(client, msg);
    }
  }
  /**
   * Broadcast a message to all clients subscribed to a collection.
   * Excludes the sender.
   */
  broadcastToCollection(collection, msg, excludeClientId, namespace) {
    for (const [id, client] of this.clients) {
      if (id === excludeClientId) continue;
      if (namespace !== void 0 && client.namespace !== namespace) continue;
      if (client.subscribedCollections.has(collection)) {
        this.sendTo(client, msg);
      }
    }
  }
  /**
   * Broadcast a message to all connected clients.
   */
  broadcastToAll(msg, namespace) {
    for (const client of this.clients.values()) {
      if (namespace !== void 0 && client.namespace !== namespace) continue;
      this.sendTo(client, msg);
    }
  }
  /**
   * Get all connected client IDs.
   */
  getClientIds() {
    return Array.from(this.clients.keys());
  }
  /**
   * Get a connected client by ID.
   */
  getClient(clientId) {
    return this.clients.get(clientId);
  }
  // ─── Heartbeat ──────────────────────────────────────────────────────────────
  startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      for (const [id, client] of this.clients) {
        if (client.ws.readyState !== import_ws.WebSocket.OPEN) {
          this.clients.delete(id);
          this.config.onDisconnect?.(id);
        }
      }
    }, HEARTBEAT_INTERVAL);
  }
  // ─── Auth Expiry Check ─────────────────────────────────────────────────────
  startAuthCheck() {
    if (!this.config.auth) return;
    this.authCheckInterval = setInterval(() => {
      const now = Date.now();
      for (const client of this.clients.values()) {
        if (!client.authExpiresAt) continue;
        const timeLeft = client.authExpiresAt - now;
        if (timeLeft <= 0) {
          this.sendTo(client, { type: "auth-expired" });
          client.ws.close();
        } else if (timeLeft <= AUTH_EXPIRY_WARNING) {
          this.sendTo(client, {
            type: "auth-expiring",
            expiresIn: Math.floor(timeLeft / 1e3)
          });
        }
      }
    }, AUTH_CHECK_INTERVAL);
  }
  // ─── Utilities ──────────────────────────────────────────────────────────────
  log(...args) {
    if (this.config.debug) {
      console.log("[Meridian WsHub]", ...args);
    }
  }
};

// src/merge.ts
var MergeEngine = class {
  config;
  conflictLog = [];
  maxConflictLog = 1e3;
  constructor(config) {
    this.config = config;
  }
  /**
   * Process a push from a client.
   * Merges operations with existing state, assigns seqNums, and broadcasts.
   *
   * @param clientId - The sending client's ID
   * @param ops - CRDT operations from the client
   * @param client - The connected client object
   */
  async processPush(clientId, ops, client) {
    if (ops.length === 0) return;
    this.log(`\u2B07\uFE0F Processing ${ops.length} ops from ${clientId}`);
    try {
      const { changes, conflicts } = await this.config.pgStore.applyOperations(ops);
      if (changes.length === 0) return;
      for (const conflict of conflicts) {
        const op = ops.find((o) => o.field === conflict.field && (o.value === conflict.winnerValue || o.value === conflict.loserValue));
        if (op) {
          const conflictRecord = {
            ...conflict,
            collection: op.collection,
            docId: op.docId,
            timestamp: Date.now()
          };
          this.conflictLog.push(conflictRecord);
          if (this.conflictLog.length > this.maxConflictLog) {
            this.conflictLog.shift();
          }
          if (this.config.onConflict) {
            this.config.onConflict(conflictRecord);
          }
        }
      }
      const lastSeq = Math.max(...changes.map((c) => c.seq));
      const opIds = ops.map((op) => op.id);
      this.config.wsHub.sendTo(client, {
        type: "ack",
        lastSeq,
        opIds
      });
      const collections = new Set(ops.map((op) => op.collection));
      for (const collection of collections) {
        const collectionChanges = changes.filter((c) => c.op.collection === collection);
        if (collectionChanges.length > 0) {
          this.config.wsHub.broadcastToCollection(
            collection,
            { type: "changes", changes: collectionChanges },
            clientId,
            client.namespace
          );
        }
      }
      this.log(`\u2705 Applied ${changes.length} changes, lastSeq=${lastSeq}`);
    } catch (e) {
      this.log(`\u274C Merge failed:`, e);
      for (const op of ops) {
        this.config.wsHub.sendTo(client, {
          type: "reject",
          opId: op.id,
          code: "VALIDATION",
          reason: e instanceof Error ? e.message : "Merge failed"
        });
      }
    }
  }
  /**
   * Process a pull request from a client.
   * Returns changes since the given sequence number.
   */
  async processPull(clientId, since, client) {
    this.log(`\u2B07\uFE0F Pull request from ${clientId}: since=${since}`);
    const changes = await this.config.pgStore.getChangesSince(since);
    if (changes === null) {
      this.config.wsHub.sendTo(client, {
        type: "full-sync-required",
        reason: "compaction",
        minSeq: this.config.pgStore.getMinSeq()
      });
      return;
    }
    const filtered = changes.filter(
      (c) => client.subscribedCollections.size === 0 || client.subscribedCollections.has(c.op.collection)
    );
    if (filtered.length > 0) {
      this.config.wsHub.sendTo(client, {
        type: "changes",
        changes: filtered
      });
    }
    this.log(`\u{1F4E4} Sent ${filtered.length} changes to ${clientId}`);
  }
  /**
   * Get the conflict log.
   */
  getConflictLog() {
    return [...this.conflictLog];
  }
  log(...args) {
    if (this.config.debug) {
      console.log("[Meridian Merge]", ...args);
    }
  }
};

// src/presence.ts
var ServerPresenceManager = class {
  presence = /* @__PURE__ */ new Map();
  wsHub;
  debug;
  constructor(wsHub, debug = false) {
    this.wsHub = wsHub;
    this.debug = debug;
  }
  /**
   * Update presence for a client and broadcast to peers.
   */
  update(clientId, data, client) {
    this.presence.set(clientId, data);
    if (this.debug) {
      console.log(`[Meridian Presence] Updated: ${clientId}`, data);
    }
    this.broadcastAll(client.namespace);
  }
  /**
   * Remove presence for a disconnected client.
   */
  remove(clientId) {
    const had = this.presence.delete(clientId);
    if (had && this.debug) {
      console.log(`[Meridian Presence] Removed: ${clientId}`);
    }
    this.broadcastAll(null);
  }
  /**
   * Get all current presence data.
   */
  getAll() {
    return Object.fromEntries(this.presence);
  }
  /**
   * Send current presence state to a specific client (e.g., on reconnect).
   */
  sendCurrentState(client) {
    this.wsHub.sendTo(client, {
      type: "presence",
      peers: Object.fromEntries(this.presence)
    });
  }
  broadcastAll(namespace) {
    this.wsHub.broadcastToAll(
      {
        type: "presence",
        peers: Object.fromEntries(this.presence)
      },
      namespace
    );
  }
  /**
   * Clear all presence data.
   */
  clear() {
    this.presence.clear();
  }
};

// src/compaction.ts
var DEFAULT_MAX_AGE = 30 * 24 * 60 * 60 * 1e3;
var DEFAULT_INTERVAL = 24 * 60 * 60 * 1e3;
var CompactionManager = class {
  pgStore;
  wsHub;
  config;
  timer = null;
  constructor(pgStore, wsHub, config) {
    this.pgStore = pgStore;
    this.wsHub = wsHub;
    this.config = {
      tombstoneMaxAge: config?.tombstoneMaxAge ?? DEFAULT_MAX_AGE,
      interval: config?.interval ?? DEFAULT_INTERVAL,
      debug: config?.debug ?? false
    };
  }
  /**
   * Start the compaction scheduler.
   */
  start() {
    this.log(`\u{1F9F9} Compaction scheduler started (interval: ${this.config.interval}ms, maxAge: ${this.config.tombstoneMaxAge}ms)`);
    setTimeout(() => this.runCompaction(), 5e3);
    this.timer = setInterval(() => this.runCompaction(), this.config.interval);
  }
  /**
   * Stop the compaction scheduler.
   */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
  /**
   * Run compaction now.
   */
  async runCompaction() {
    this.log("\u{1F9F9} Running compaction...");
    try {
      const deleted = await this.pgStore.compact(this.config.tombstoneMaxAge);
      const minSeq = this.pgStore.getMinSeq();
      if (deleted > 0) {
        this.log(`\u{1F9F9} Compacted ${deleted} tombstones. New minSeq: ${minSeq}`);
        this.wsHub.broadcastToAll({
          type: "compaction",
          minSeq
        });
      } else {
        this.log("\u{1F9F9} No tombstones to compact");
      }
      return deleted;
    } catch (e) {
      this.log("\u274C Compaction failed:", e);
      return 0;
    }
  }
  log(...args) {
    if (this.config.debug) {
      console.log("[Meridian Compaction]", ...args);
    }
  }
};

// src/server.ts
function createServer(config) {
  const {
    port,
    database,
    schema,
    path = "/sync",
    auth,
    compaction,
    onConflict,
    debug = false
  } = config;
  const pgStore = new PgStore({
    connectionString: database,
    schema
  });
  let mergeEngine;
  let presenceManager;
  const wsHub = new WsHub({
    port,
    path,
    auth,
    debug,
    onMessage: (clientId, msg, client) => {
      switch (msg.type) {
        case "push":
          mergeEngine.processPush(clientId, msg.ops, client);
          break;
        case "pull":
          mergeEngine.processPull(clientId, msg.since, client);
          break;
        case "presence":
          presenceManager.update(clientId, msg.data, client);
          break;
        default:
          break;
      }
    },
    onDisconnect: (clientId) => {
      presenceManager.remove(clientId);
    }
  });
  mergeEngine = new MergeEngine({
    pgStore,
    wsHub,
    debug,
    onConflict
  });
  presenceManager = new ServerPresenceManager(wsHub, debug);
  const compactionManager = new CompactionManager(pgStore, wsHub, {
    tombstoneMaxAge: compaction?.tombstoneMaxAge,
    interval: compaction?.interval,
    debug
  });
  pgStore.onChange((tableName, docId) => {
    if (debug) {
      console.log(`[Meridian Server] \u{1F4E2} DB change: ${tableName}/${docId}`);
    }
  });
  return {
    async start() {
      if (debug) {
        console.log("[Meridian Server] \u{1F680} Starting...");
        console.log(`[Meridian Server] \u{1F4E6} Schema v${schema.version}: ${Object.keys(schema.collections).join(", ")}`);
        console.log(`[Meridian Server] \u{1F418} Database: ${database.replace(/\/\/.*@/, "//***@")}`);
      }
      await pgStore.init();
      wsHub.start();
      compactionManager.start();
      if (debug) {
        console.log(`[Meridian Server] \u2705 Ready on ws://localhost:${port}${path}`);
      }
    },
    async stop() {
      if (debug) {
        console.log("[Meridian Server] \u{1F6D1} Stopping...");
      }
      compactionManager.stop();
      wsHub.stop();
      presenceManager.clear();
      await pgStore.close();
      if (debug) {
        console.log("[Meridian Server] \u2705 Stopped");
      }
    },
    async compact() {
      return compactionManager.runCompaction();
    },
    getClientCount() {
      return wsHub.getClientIds().length;
    }
  };
}

// src/index.ts
var import_shared2 = require("@meridian-sync/shared");
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CompactionManager,
  MergeEngine,
  PgStore,
  ServerPresenceManager,
  WsHub,
  createServer,
  defineSchema,
  z
});
