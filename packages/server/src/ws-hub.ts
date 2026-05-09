/**
 * Meridian Server — WebSocket Hub
 *
 * Manages WebSocket connections with:
 * - Client authentication (pluggable JWT verifier)
 * - Namespace isolation (multi-tenant)
 * - Message routing (push/pull/subscribe/presence)
 * - Heartbeat/ping-pong health checks
 * - Auth token expiry tracking and refresh notifications
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type {
  ClientMessage,
  ServerMessage,
  ConnectionState,
} from '@meridian-sync/shared';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AuthResult {
  userId: string;
  namespace?: string;
  expiresAt?: number; // Unix timestamp in ms
}

export interface WsHubConfig {
  /** Port to listen on */
  port: number;
  /** Path for WebSocket endpoint */
  path?: string;
  /** Auth verifier — return user info or throw to reject */
  auth?: (token: string) => Promise<AuthResult>;
  /** Message handler */
  onMessage: (clientId: string, message: ClientMessage, client: ConnectedClient) => void;
  /** Disconnect handler */
  onDisconnect?: (clientId: string) => void;
  /** Debug mode */
  debug?: boolean;
}

export interface ConnectedClient {
  id: string;
  ws: WebSocket;
  userId: string | null;
  namespace: string | null;
  subscribedCollections: Set<string>;
  authExpiresAt: number | null;
  lastActivity: number;
}

const HEARTBEAT_INTERVAL = 30000;
const AUTH_EXPIRY_WARNING = 5 * 60 * 1000; // 5 minutes before expiry
const AUTH_CHECK_INTERVAL = 60000; // Check auth expiry every minute

/**
 * WebSocket connection hub for Meridian server.
 */
export class WsHub {
  private wss: WebSocketServer | null = null;
  private readonly config: WsHubConfig;
  private clients: Map<string, ConnectedClient> = new Map();
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private authCheckInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: WsHubConfig) {
    this.config = config;
  }

  /**
   * Start the WebSocket server.
   */
  start(): void {
    const { port, path = '/sync' } = this.config;

    this.wss = new WebSocketServer({ port, path });

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      this.handleConnection(ws, req);
    });

    this.startHeartbeat();
    this.startAuthCheck();

    this.log(`🔌 WebSocket server listening on ws://localhost:${port}${path}`);
  }

  /**
   * Stop the WebSocket server.
   */
  stop(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (this.authCheckInterval) {
      clearInterval(this.authCheckInterval);
      this.authCheckInterval = null;
    }

    // Close all client connections
    for (const client of this.clients.values()) {
      client.ws.close();
    }
    this.clients.clear();

    this.wss?.close();
    this.wss = null;
  }

  // ─── Connection Handling ────────────────────────────────────────────────────

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const clientId = `client-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    const client: ConnectedClient = {
      id: clientId,
      ws,
      userId: null,
      namespace: null,
      subscribedCollections: new Set(),
      authExpiresAt: null,
      lastActivity: Date.now(),
    };

    this.clients.set(clientId, client);
    this.log(`🔗 Client connected: ${clientId}`);

    ws.on('message', async (data: Buffer | string) => {
      client.lastActivity = Date.now();

      const raw = data.toString();

      // Handle ping
      if (raw === 'ping') {
        ws.send('pong');
        return;
      }

      try {
        const msg: ClientMessage = JSON.parse(raw);
        await this.handleClientMessage(clientId, msg, client);
      } catch (e) {
        this.sendTo(client, {
          type: 'error',
          code: 'PARSE_ERROR',
          message: 'Failed to parse message',
        });
      }
    });

    ws.on('close', () => {
      this.log(`🔌 Client disconnected: ${clientId}`);
      this.clients.delete(clientId);
      this.config.onDisconnect?.(clientId);
    });

    ws.on('error', (err) => {
      this.log(`❌ Client error (${clientId}):`, err.message);
    });
  }

  private async handleClientMessage(
    clientId: string,
    msg: ClientMessage,
    client: ConnectedClient
  ): Promise<void> {
    // Handle auth first
    if (msg.type === 'auth') {
      if (this.config.auth) {
        try {
          const result = await this.config.auth(msg.token);
          client.userId = result.userId;
          client.namespace = result.namespace ?? null;
          client.authExpiresAt = result.expiresAt ?? null;

          this.log(`🔑 Client ${clientId} authenticated as ${result.userId}`);
        } catch (e) {
          this.sendTo(client, {
            type: 'error',
            code: 'AUTH_FAILED',
            message: e instanceof Error ? e.message : 'Authentication failed',
          });
          client.ws.close();
          return;
        }
      }
      return;
    }

    // Check auth requirement
    if (this.config.auth && !client.userId) {
      this.sendTo(client, {
        type: 'error',
        code: 'AUTH_REQUIRED',
        message: 'Authentication required. Send an auth message first.',
      });
      return;
    }

    // Handle subscribe
    if (msg.type === 'subscribe') {
      for (const collection of msg.collections) {
        client.subscribedCollections.add(collection);
      }
      this.log(`📋 Client ${clientId} subscribed to: ${msg.collections.join(', ')}`);
      return;
    }

    // Delegate to handler
    this.config.onMessage(clientId, msg, client);
  }

  // ─── Broadcasting ──────────────────────────────────────────────────────────

  /**
   * Send a message to a specific client.
   */
  sendTo(client: ConnectedClient, msg: ServerMessage): void {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(msg));
    }
  }

  /**
   * Send a message to a client by ID.
   */
  sendToId(clientId: string, msg: ServerMessage): void {
    const client = this.clients.get(clientId);
    if (client) {
      this.sendTo(client, msg);
    }
  }

  /**
   * Broadcast a message to all clients subscribed to a collection.
   * Excludes the sender.
   */
  broadcastToCollection(
    collection: string,
    msg: ServerMessage,
    excludeClientId?: string,
    namespace?: string | null
  ): void {
    for (const [id, client] of this.clients) {
      if (id === excludeClientId) continue;
      if (namespace !== undefined && client.namespace !== namespace) continue;
      if (client.subscribedCollections.has(collection)) {
        this.sendTo(client, msg);
      }
    }
  }

  /**
   * Broadcast a message to all connected clients.
   */
  broadcastToAll(msg: ServerMessage, namespace?: string | null): void {
    for (const client of this.clients.values()) {
      if (namespace !== undefined && client.namespace !== namespace) continue;
      this.sendTo(client, msg);
    }
  }

  /**
   * Get all connected client IDs.
   */
  getClientIds(): string[] {
    return Array.from(this.clients.keys());
  }

  /**
   * Get a connected client by ID.
   */
  getClient(clientId: string): ConnectedClient | undefined {
    return this.clients.get(clientId);
  }

  // ─── Heartbeat ──────────────────────────────────────────────────────────────

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      for (const [id, client] of this.clients) {
        if (client.ws.readyState !== WebSocket.OPEN) {
          this.clients.delete(id);
          this.config.onDisconnect?.(id);
        }
      }
    }, HEARTBEAT_INTERVAL);
  }

  // ─── Auth Expiry Check ─────────────────────────────────────────────────────

  private startAuthCheck(): void {
    if (!this.config.auth) return;

    this.authCheckInterval = setInterval(() => {
      const now = Date.now();

      for (const client of this.clients.values()) {
        if (!client.authExpiresAt) continue;

        const timeLeft = client.authExpiresAt - now;

        if (timeLeft <= 0) {
          // Token expired
          this.sendTo(client, { type: 'auth-expired' });
          client.ws.close();
        } else if (timeLeft <= AUTH_EXPIRY_WARNING) {
          // Token about to expire — warn client
          this.sendTo(client, {
            type: 'auth-expiring',
            expiresIn: Math.floor(timeLeft / 1000),
          });
        }
      }
    }, AUTH_CHECK_INTERVAL);
  }

  // ─── Utilities ──────────────────────────────────────────────────────────────

  private log(...args: unknown[]): void {
    if (this.config.debug) {
      console.log('[Meridian WsHub]', ...args);
    }
  }
}
