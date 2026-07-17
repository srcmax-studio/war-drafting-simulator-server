import { randomUUID } from 'node:crypto';
import { WebSocket, type RawData } from 'ws';
import { PROTOCOL_VERSION } from '../common/src/index.js';
import type { ServerConfig } from '../config.js';
import { TokenBucket } from '../rate-limit/RateLimiter.js';
import { Logger } from '../utils.js';

export interface ManagedConnection {
  id: string;
  ws: WebSocket;
  remoteName: string;
  authenticated: boolean;
  lastPong: number;
  lastActivity: number;
  sequence: number;
  processed: Set<string>;
  limiter: TokenBucket;
}

export interface OutboundScope {
  requestId?: string;
  roomId?: string;
  gameId?: string;
}

interface ConnectionCallbacks {
  onMessage: (connection: ManagedConnection, raw: string) => void;
  onClose: (connection: ManagedConnection) => void;
  onMessageRecorded: () => void;
  onErrorRecorded: () => void;
}

export class ConnectionManager {
  private readonly connections = new Map<string, ManagedConnection>();

  constructor(
    private readonly config: ServerConfig,
    private readonly callbacks: ConnectionCallbacks
  ) {}

  accept(ws: WebSocket, remoteName: string): ManagedConnection | null {
    if (this.connections.size >= this.config.maxConnections) {
      ws.close(4003, 'Server connection limit reached.');
      return null;
    }
    const now = Date.now();
    const connection: ManagedConnection = {
      id: randomUUID(),
      ws,
      remoteName,
      authenticated: !this.config.password,
      lastPong: now,
      lastActivity: now,
      sequence: 0,
      processed: new Set(),
      limiter: new TokenBucket(this.config.messagesPerSecond, this.config.messageBurst, now)
    };
    this.connections.set(connection.id, connection);
    ws.on('message', (data: RawData) => this.receive(connection, data));
    ws.on('pong', () => { connection.lastPong = Date.now(); });
    ws.on('close', () => {
      if (!this.connections.delete(connection.id)) return;
      this.callbacks.onClose(connection);
    });
    ws.on('error', (error) => Logger.warning(`WebSocket transport error: ${error.message}`));
    return connection;
  }

  get(connectionId: string): ManagedConnection | undefined {
    return this.connections.get(connectionId);
  }

  values(): ManagedConnection[] {
    return [...this.connections.values()];
  }

  markProcessed(connection: ManagedConnection, requestId: string): void {
    connection.processed.add(requestId);
    while (connection.processed.size > 500) connection.processed.delete(connection.processed.values().next().value as string);
  }

  send(connection: ManagedConnection, event: string, payload: unknown, scope: OutboundScope = {}): boolean {
    if (connection.ws.readyState !== WebSocket.OPEN) return false;
    if (connection.ws.bufferedAmount > this.config.maxBackpressureBytes) {
      connection.ws.close(4004, 'Backpressure limit exceeded.');
      this.callbacks.onErrorRecorded();
      return false;
    }
    connection.sequence += 1;
    const message: Record<string, unknown> = {
      event,
      protocolVersion: PROTOCOL_VERSION,
      sequence: connection.sequence,
      payload
    };
    if (scope.requestId !== undefined) message.requestId = scope.requestId;
    if (scope.roomId !== undefined) message.roomId = scope.roomId;
    if (scope.gameId !== undefined) message.gameId = scope.gameId;
    connection.ws.send(JSON.stringify(message));
    return true;
  }

  heartbeat(now = Date.now()): void {
    for (const connection of this.connections.values()) {
      if (now - connection.lastActivity > this.config.idleConnectionMs || now - connection.lastPong > 15_000) {
        connection.ws.close(4001, 'Connection timeout.');
      } else if (connection.ws.readyState === WebSocket.OPEN) {
        connection.ws.ping();
      }
    }
  }

  closeAll(): void {
    for (const connection of this.connections.values()) connection.ws.terminate();
    this.connections.clear();
  }

  private receive(connection: ManagedConnection, data: RawData): void {
    const raw = data.toString();
    connection.lastActivity = Date.now();
    this.callbacks.onMessageRecorded();
    if (Buffer.byteLength(raw, 'utf8') > this.config.maxMessageBytes) {
      connection.ws.close(4002, 'Message too large.');
      this.callbacks.onErrorRecorded();
      return;
    }
    if (!connection.limiter.take()) {
      connection.ws.close(4008, 'Message rate exceeded.');
      this.callbacks.onErrorRecorded();
      return;
    }
    this.callbacks.onMessage(connection, raw);
  }
}
