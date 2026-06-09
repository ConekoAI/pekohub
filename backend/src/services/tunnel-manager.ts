/**
 * TunnelManager — Central coordinator for runtime WebSocket tunnels.
 *
 * Owns all runtime connections, handles authentication, heartbeats,
 * request routing, and control messages.
 */

import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import {
  decodeTunnelMessage,
  encodeTunnelMessage,
  type TunnelMessage,
  type HttpProxiedRequest,
  type InstanceAnnouncePayload,
  type InstanceHeartbeatPayload,
  type InstanceDeregisterPayload,
} from './tunnel-protocol.js';
import { verifyDidKeySignature, TunnelAuthError } from './tunnel-crypto.js';
import { instanceService, type InstanceStatus } from './instances.js';
import { db } from '../db/index.js';
import { runtimes, instances } from '../db/schema.js';
import { eq, inArray, and } from 'drizzle-orm';

const HELLO_TIMEOUT_MS = 10_000;
const HEARTBEAT_INTERVAL_SECS = 30;
const HEARTBEAT_TIMEOUT_MS = 90_000;
const REAPER_INTERVAL_MS = 30_000;

export interface PendingRequest {
  resolve: (value: { status: number; body: unknown }) => void;
  reject: (reason: Error) => void;
  streamSink?: StreamSink;
  receivedStreamInit: boolean;
  chunks: string[];
  timer?: NodeJS.Timeout;
}

export interface StreamSink {
  onChunk: (chunk: string) => void;
  onEnd: () => void;
  onError: (err: Error) => void;
}

export interface RuntimeConnection {
  runtimeId: string;
  socket: WebSocket;
  connectedAt: Date;
  lastHeartbeatAt: Date;
  heartbeatTimeout: NodeJS.Timeout | null;
  pendingRequestIds: Set<string>;
}

export class TunnelManager {
  private connections = new Map<string, RuntimeConnection>();
  private pendingRequests = new Map<string, PendingRequest>();
  private reaperTimer: NodeJS.Timeout | null = null;

  constructor(private fastify: FastifyInstance) {}

  startReaper(): void {
    if (this.reaperTimer) return;
    this.reaperTimer = setInterval(() => {
      this.reapStaleConnections();
    }, REAPER_INTERVAL_MS);
    this.reaperTimer.unref?.();
  }

  stopReaper(): void {
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }
  }

  async handleSocket(socket: WebSocket): Promise<void> {
    // Wait for RuntimeHello as the first binary/text frame
    const helloTimer = setTimeout(() => {
      if (socket.readyState === socket.OPEN) {
        this.sendMessage(socket, { type: 'disconnect', reason: 'RuntimeHello timeout' });
        socket.close(1008, 'RuntimeHello timeout');
      }
    }, HELLO_TIMEOUT_MS);

    const onMessage = async (data: Buffer | ArrayBuffer | Buffer[]) => {
      clearTimeout(helloTimer);

      let msg: TunnelMessage;
      try {
        msg = decodeTunnelMessage(data);
      } catch (err) {
        this.fastify.log.warn({ err }, 'Failed to decode tunnel message');
        this.sendMessage(socket, { type: 'disconnect', reason: 'Invalid message encoding' });
        socket.close(1003, 'Invalid message encoding');
        return;
      }

      if (msg.type !== 'runtime_hello') {
        this.sendMessage(socket, { type: 'disconnect', reason: 'Expected RuntimeHello' });
        socket.close(1008, 'Expected RuntimeHello');
        return;
      }

      try {
        await this.authenticateHello(socket, msg);
      } catch (err) {
        this.fastify.log.warn({ err, runtimeId: msg.runtimeId }, 'Tunnel authentication failed');
        this.sendMessage(socket, {
          type: 'disconnect',
          reason: err instanceof TunnelAuthError ? err.message : 'Authentication failed',
        });
        socket.close(1008, 'Authentication failed');
      }
    };

    socket.once('message', onMessage);

    socket.once('close', () => {
      clearTimeout(helloTimer);
    });
  }

  private async authenticateHello(
    socket: WebSocket,
    hello: Extract<TunnelMessage, { type: 'runtime_hello' }>
  ): Promise<void> {
    const { runtimeId, nonce, signature } = hello;

    // Verify signature using pubkey derived from did:key
    const valid = verifyDidKeySignature(runtimeId, nonce, signature);
    if (!valid) {
      throw new TunnelAuthError('Invalid RuntimeHello signature');
    }

    // If a connection already exists for this runtime, close the old one
    const existing = this.connections.get(runtimeId);
    if (existing) {
      this.fastify.log.info({ runtimeId }, 'Replacing existing tunnel connection');
      this.closeConnection(existing, 'new connection from same runtime');
    }

    const conn: RuntimeConnection = {
      runtimeId,
      socket,
      connectedAt: new Date(),
      lastHeartbeatAt: new Date(),
      heartbeatTimeout: null,
      pendingRequestIds: new Set(),
    };

    this.connections.set(runtimeId, conn);
    this.resetHeartbeatTimeout(conn);

    // Send TunnelReady
    this.sendMessage(socket, {
      type: 'tunnel_ready',
      heartbeatIntervalSecs: HEARTBEAT_INTERVAL_SECS,
    });

    // Wire message handler
    const messageHandler = (data: Buffer | ArrayBuffer | Buffer[]) => {
      this.handleMessage(conn, data).catch((err) => {
        this.fastify.log.warn({ err, runtimeId }, 'Error handling tunnel message');
      });
    };
    socket.on('message', messageHandler);

    socket.once('close', () => {
      this.handleDisconnect(conn);
    });

    socket.once('error', (err) => {
      this.fastify.log.warn({ err, runtimeId }, 'Tunnel socket error');
      this.handleDisconnect(conn);
    });

    this.fastify.log.info({ runtimeId }, 'Runtime tunnel authenticated');
  }

  private async handleMessage(conn: RuntimeConnection, data: Buffer | ArrayBuffer | Buffer[]): Promise<void> {
    let msg: TunnelMessage;
    try {
      msg = decodeTunnelMessage(data);
    } catch (err) {
      this.fastify.log.warn({ err, runtimeId: conn.runtimeId }, 'Failed to decode tunnel message');
      return;
    }

    switch (msg.type) {
      case 'heartbeat': {
        conn.lastHeartbeatAt = new Date();
        this.resetHeartbeatTimeout(conn);
        this.sendMessage(conn.socket, { type: 'heartbeat_ack', seq: msg.seq });
        break;
      }

      case 'heartbeat_ack': {
        // Runtime-side concern; server just acknowledges
        break;
      }

      case 'proxied_response': {
        this.handleProxiedResponse(msg.requestId, msg.payload);
        break;
      }

      case 'stream_chunk': {
        this.handleStreamChunk(msg.requestId, msg.payload);
        break;
      }

      case 'stream_end': {
        this.handleStreamEnd(msg.requestId);
        break;
      }

      case 'instance_announce': {
        await this.handleInstanceAnnounce(conn.runtimeId, msg.payload);
        break;
      }

      case 'instance_heartbeat': {
        await this.handleInstanceHeartbeat(conn.runtimeId, msg.payload);
        break;
      }

      case 'instance_deregister': {
        await this.handleInstanceDeregister(conn.runtimeId, msg.payload);
        break;
      }

      case 'disconnect': {
        this.fastify.log.info({ runtimeId: conn.runtimeId, reason: msg.reason }, 'Runtime sent disconnect');
        this.closeConnection(conn, msg.reason);
        break;
      }

      case 'runtime_hello':
      case 'tunnel_ready':
      case 'proxied_request':
      case 'exposure_update': {
        // Unexpected direction
        this.fastify.log.warn(
          { type: msg.type, runtimeId: conn.runtimeId },
          'Unexpected tunnel message direction from runtime'
        );
        break;
      }

      default: {
        // Exhaustiveness fallback
        this.fastify.log.warn(
          { type: (msg as TunnelMessage).type, runtimeId: conn.runtimeId },
          'Unknown tunnel message type'
        );
      }
    }
  }

  private handleProxiedResponse(requestId: string, payload: number[]): void {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return;

    try {
      const text = Buffer.from(payload).toString('utf8');
      const parsed = JSON.parse(text) as { status?: number; body?: unknown };
      pending.resolve({ status: parsed.status ?? 200, body: parsed.body ?? null });
    } catch {
      // Fallback: treat raw bytes as body
      pending.resolve({ status: 200, body: Buffer.from(payload).toString('utf8') });
    }

    this.pendingRequests.delete(requestId);
    const conn = connForRequestId(this.connections, requestId);
    conn?.pendingRequestIds.delete(requestId);
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
  }

  private handleStreamChunk(requestId: string, payload: number[]): void {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return;

    const chunk = Buffer.from(payload).toString('utf8');

    if (pending.streamSink) {
      pending.receivedStreamInit = true;
      try {
        pending.streamSink.onChunk(chunk);
      } catch (err) {
        pending.streamSink.onError(err instanceof Error ? err : new Error(String(err)));
        this.rejectRequest(requestId, new Error('Stream sink error'));
      }
    } else {
      pending.receivedStreamInit = true;
      pending.chunks.push(chunk);
    }

    const conn = connForRequestId(this.connections, requestId);
    conn?.pendingRequestIds.delete(requestId);
  }

  private handleStreamEnd(requestId: string): void {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return;

    if (pending.streamSink) {
      try {
        pending.streamSink.onEnd();
      } catch (err) {
        pending.streamSink.onError(err instanceof Error ? err : new Error(String(err)));
      }
      pending.resolve({ status: 200, body: null });
      this.pendingRequests.delete(requestId);
      const conn = connForRequestId(this.connections, requestId);
      conn?.pendingRequestIds.delete(requestId);
      if (pending.timer) clearTimeout(pending.timer);
      return;
    }

    // Non-streaming fallback: concatenate chunks and resolve
    const body = pending.chunks.length > 0 ? pending.chunks.join('') : '';
    pending.resolve({ status: 200, body });
    this.pendingRequests.delete(requestId);
    const conn = connForRequestId(this.connections, requestId);
    conn?.pendingRequestIds.delete(requestId);
    if (pending.timer) clearTimeout(pending.timer);
  }

  async resolveRuntimeOwner(runtimeId: string): Promise<number | null> {
    const row = await db.query.runtimes.findFirst({
      where: eq(runtimes.runtimeDid, runtimeId),
    });
    return row?.ownerId ?? null;
  }

  private async handleInstanceAnnounce(
    runtimeId: string,
    payload: InstanceAnnouncePayload
  ): Promise<void> {
    let ownerId = await this.resolveRuntimeOwner(runtimeId);
    if (ownerId === null) {
      this.fastify.log.warn({ runtimeId, instanceId: payload.id }, 'No runtime record found; falling back to ownerId 0');
      ownerId = 0;
    }

    try {
      await instanceService.upsertFromAnnounce({
        id: payload.id,
        type: payload.type,
        name: payload.name,
        ownerId,
        runtimeId,
        runtimeDisplayName: payload.runtimeDisplayName,
        bundleRef: payload.bundleRef,
        status: payload.status,
        exposure: payload.exposure,
        allowedUsers: payload.allowedUsers,
        capabilities: payload.capabilities,
        metadata: payload.metadata,
      });
    } catch (err) {
      this.fastify.log.warn({ err, runtimeId, instanceId: payload.id }, 'Failed to upsert instance from announce');
    }
  }

  private async handleInstanceHeartbeat(
    runtimeId: string,
    payload: InstanceHeartbeatPayload
  ): Promise<void> {
    try {
      await instanceService.heartbeat(payload.id, payload.status as InstanceStatus);
    } catch (err) {
      this.fastify.log.warn({ err, runtimeId, instanceId: payload.id }, 'Failed to process instance heartbeat');
    }
  }

  private async handleInstanceDeregister(
    _runtimeId: string,
    payload: InstanceDeregisterPayload
  ): Promise<void> {
    try {
      await instanceService.delete(payload.id);
    } catch (err) {
      this.fastify.log.warn({ err, instanceId: payload.id }, 'Failed to deregister instance');
    }
  }

  private handleDisconnect(conn: RuntimeConnection): void {
    if (conn.heartbeatTimeout) {
      clearTimeout(conn.heartbeatTimeout);
      conn.heartbeatTimeout = null;
    }

    // Reject pending requests
    for (const requestId of conn.pendingRequestIds) {
      this.rejectRequest(requestId, new Error('Tunnel disconnected'));
    }
    conn.pendingRequestIds.clear();

    if (this.connections.get(conn.runtimeId) === conn) {
      this.connections.delete(conn.runtimeId);
    }

    // Mark hosted instances offline
    this.markRuntimeOffline(conn.runtimeId).catch((err) => {
      this.fastify.log.warn({ err, runtimeId: conn.runtimeId }, 'Failed to mark runtime offline');
    });

    this.fastify.log.info({ runtimeId: conn.runtimeId }, 'Runtime tunnel disconnected');
  }

  private closeConnection(conn: RuntimeConnection, reason: string): void {
    if (conn.socket.readyState === conn.socket.OPEN) {
      this.sendMessage(conn.socket, { type: 'disconnect', reason });
      conn.socket.close(1000, reason);
    }
  }

  private resetHeartbeatTimeout(conn: RuntimeConnection): void {
    if (conn.heartbeatTimeout) {
      clearTimeout(conn.heartbeatTimeout);
    }
    conn.heartbeatTimeout = setTimeout(() => {
      this.fastify.log.warn({ runtimeId: conn.runtimeId }, 'Tunnel heartbeat timeout');
      this.closeConnection(conn, 'heartbeat timeout');
      this.handleDisconnect(conn);
    }, HEARTBEAT_TIMEOUT_MS);
    conn.heartbeatTimeout.unref?.();
  }

  private reapStaleConnections(): void {
    const now = Date.now();
    for (const conn of this.connections.values()) {
      if (now - conn.lastHeartbeatAt.getTime() > HEARTBEAT_TIMEOUT_MS) {
        this.fastify.log.warn({ runtimeId: conn.runtimeId }, 'Reaping stale tunnel connection');
        this.closeConnection(conn, 'heartbeat timeout');
        this.handleDisconnect(conn);
      }
    }
  }

  async sendProxiedRequest(
    runtimeId: string,
    request: HttpProxiedRequest,
    timeoutMs: number = 30_000
  ): Promise<{ status: number; body: unknown }> {
    const conn = this.connections.get(runtimeId);
    if (!conn || conn.socket.readyState !== conn.socket.OPEN) {
      throw new Error('Runtime not connected');
    }

    return new Promise((resolve, reject) => {
      const pending: PendingRequest = {
        resolve,
        reject,
        receivedStreamInit: false,
        chunks: [],
      };

      this.pendingRequests.set(request.requestId, pending);
      conn.pendingRequestIds.add(request.requestId);

      this.sendMessage(conn.socket, {
        type: 'proxied_request',
        requestId: request.requestId,
        agent: request.instanceId, // fallback agent identifier
        payload: Array.from(encodeHttpRequestBody(request)),
      });

      const timer = setTimeout(() => {
        if (this.pendingRequests.has(request.requestId)) {
          this.pendingRequests.delete(request.requestId);
          conn.pendingRequestIds.delete(request.requestId);
          reject(new Error('Proxy request timeout'));
        }
      }, timeoutMs);
      timer.unref?.();
      pending.timer = timer;
    });
  }

  async startStream(
    runtimeId: string,
    request: HttpProxiedRequest,
    sink: StreamSink,
    timeoutMs: number = 30_000
  ): Promise<void> {
    const conn = this.connections.get(runtimeId);
    if (!conn || conn.socket.readyState !== conn.socket.OPEN) {
      throw new Error('Runtime not connected');
    }

    return new Promise((resolve, reject) => {
      const pending: PendingRequest = {
        resolve: (result) => {
          // If resolved without stream init, treat as immediate response
          if (!pending.receivedStreamInit) {
            try {
              sink.onChunk(String(result.body ?? ''));
              sink.onEnd();
            } catch (err) {
              sink.onError(err instanceof Error ? err : new Error(String(err)));
            }
          }
          try { resolve(); } catch { /* already resolved */ }
        },
        reject: (err) => {
          sink.onError(err);
          reject(err);
        },
        streamSink: sink,
        receivedStreamInit: false,
        chunks: [],
      };

      this.pendingRequests.set(request.requestId, pending);
      conn.pendingRequestIds.add(request.requestId);

      this.sendMessage(conn.socket, {
        type: 'proxied_request',
        requestId: request.requestId,
        agent: request.instanceId,
        payload: Array.from(encodeHttpRequestBody(request)),
      });

      const timer = setTimeout(() => {
        if (this.pendingRequests.has(request.requestId)) {
          this.pendingRequests.delete(request.requestId);
          conn.pendingRequestIds.delete(request.requestId);
          const err = new Error('Stream request timeout');
          sink.onError(err);
          reject(err);
        }
      }, timeoutMs);
      timer.unref?.();
      pending.timer = timer;
    });
  }

  async broadcastControl(runtimeId: string, message: TunnelMessage): Promise<void> {
    const conn = this.connections.get(runtimeId);
    if (!conn || conn.socket.readyState !== conn.socket.OPEN) {
      return;
    }
    this.sendMessage(conn.socket, message);
  }

  async markRuntimeOffline(runtimeId: string): Promise<void> {
    try {
      // Mark all instances hosted by this runtime as offline in a single bulk UPDATE
      await db
        .update(instances)
        .set({ status: 'offline' })
        .where(
          and(
            eq(instances.runtimeId, runtimeId),
            inArray(instances.status, ['online', 'busy'])
          )
        );
    } catch (err) {
      this.fastify.log.warn({ err, runtimeId }, 'Failed to mark runtime instances offline');
    }
  }

  isRuntimeConnected(runtimeId: string): boolean {
    const conn = this.connections.get(runtimeId);
    return !!conn && conn.socket.readyState === conn.socket.OPEN;
  }

  private sendMessage(socket: WebSocket, msg: TunnelMessage): void {
    if (socket.readyState === socket.OPEN) {
      socket.send(encodeTunnelMessage(msg));
    }
  }

  private rejectRequest(requestId: string, error: Error): void {
    const pending = this.pendingRequests.get(requestId);
    if (pending) {
      this.pendingRequests.delete(requestId);
      pending.reject(error);
    }
  }
}

function connForRequestId(
  connections: Map<string, RuntimeConnection>,
  requestId: string
): RuntimeConnection | undefined {
  for (const conn of connections.values()) {
    if (conn.pendingRequestIds.has(requestId)) return conn;
  }
  return undefined;
}

function encodeHttpRequestBody(request: HttpProxiedRequest): Buffer {
  return Buffer.from(
    JSON.stringify({
      requestId: request.requestId,
      instanceId: request.instanceId,
      method: request.method,
      body: request.body,
      headers: request.headers,
    }),
    'utf8'
  );
}

export { HEARTBEAT_INTERVAL_SECS, HEARTBEAT_TIMEOUT_MS };
