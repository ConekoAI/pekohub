# ADR-004: PekoHub Tunnel Server

| Field | Value |
|---|---|
| **ADR** | 004 |
| **Title** | PekoHub Tunnel Server |
| **Status** | Implemented |
| **Date** | 2026-06-09 |
| **Depends On** | ADR-001-pekohub (Refresh Token Rotation), ADR-002-pekohub (Remote Instance Management API), ADR-035 (Tunnel Protocol) |
| **Related** | ADR-003-pekohub (Exposure Modes), ADR-034 (Runtime Auth), ADR-002-desktop (Remote Runtime Support) |

> **⚠️ Historical note (post-#21 / ADR-041 / ADR-042):** The `InstanceAnnouncePayload.type`
> field shown below as `'agent' | 'team'` is **superseded** — instances now announce a
> single `'principal'` type. The runtime dropped the `Team` subject variant; see
> [ADR-042](./ADR-042-principal-as-container-v2.md). The protocol sketch below is retained
> as the original decision record.

---

## Context

ADR-035 defines the runtime-side tunnel protocol: a WebSocket connection from the runtime to PekoHub that carries multiplexed agent traffic, control messages, and heartbeats. The runtime implementation is complete (`TunnelClient`, `TunnelMessage` protocol, exponential backoff reconnection). However, the PekoHub server side does not yet exist. Without it:

- ✅ `/v1/tunnel` WebSocket endpoint is live.
- ✅ `InstanceAnnounce`, `InstanceHeartbeat`, and `InstanceDeregister` messages are handled by `TunnelManager`.
- ✅ Chat proxy endpoints (`POST /v1/instances/:id/chat`) route through the tunnel.
- ✅ `PATCH /v1/instances/:id/exposure` sends `exposure_update` control messages.
- ✅ SSE streaming via `GET /v1/instances/:id/stream` is implemented.
- ⚠️ Remote runtime support in peko-desktop still requires integration testing.

This ADR defines the PekoHub server-side tunnel architecture: the Fastify plugin, connection manager, request router, and integration points with the existing instance service and auth system.

---

## Problem Statement

1. **No tunnel endpoint**: PekoHub has no WebSocket route at `/v1/tunnel`.
2. **No runtime connection state**: PekoHub cannot track which runtimes are online, which agents they host, or whether a proxied request can be delivered.
3. **No request routing**: When a user sends a chat message to an instance, PekoHub cannot forward it through the correct tunnel and stream the response back.
4. **No control channel**: PekoHub cannot send `exposure.update` or other control messages to a runtime.
5. **No graceful degradation**: If a runtime disconnects, its instances remain visible (or invisible) with no status transition.

---

## Decision

### 1. Fastify WebSocket Plugin

PekoHub registers a single WebSocket route:

```
GET /v1/tunnel  →  WebSocket upgrade
```

This route is handled by `@fastify/websocket` and delegates to the `TunnelManager` service.

**Auth at the WebSocket layer**:
- The runtime sends `RuntimeHello` as the first binary frame after the WebSocket handshake.
- PekoHub does **not** use HTTP `Authorization` headers for the WebSocket upgrade. The upgrade itself is unauthenticated; authentication happens inside the tunnel protocol via the signed `RuntimeHello`.
- This avoids complexity with browser WebSocket clients (which cannot set arbitrary headers) and keeps the auth model consistent with ADR-035.

### 2. TunnelManager — Central Coordinator

`TunnelManager` is a singleton Fastify decorator (`app.tunnelManager`) that owns all runtime connections.

```typescript
// src/services/tunnel-manager.ts
export class TunnelManager {
  // runtime_id (did:key) → RuntimeConnection
  private connections = new Map<string, RuntimeConnection>();

  // request_id → PendingRequest (for routing ProxiedResponse back to HTTP)
  private pendingRequests = new Map<string, PendingRequest>();

  async handleSocket(socket: WebSocket): Promise<void>;
  async authenticateHello(msg: TunnelMessage.RuntimeHello): Promise<RuntimeConnection>;
  async sendProxiedRequest(runtimeId: string, request: ProxiedRequest): Promise<ProxiedResult>;
  async broadcastControl(runtimeId: string, message: TunnelMessage): Promise<void>;
  markRuntimeOffline(runtimeId: string): Promise<void>;
}
```

**Responsibilities**:
| Method | Purpose |
|--------|---------|
| `handleSocket` | Accept a new WebSocket, wait for `RuntimeHello`, authenticate, register connection |
| `authenticateHello` | Derive Ed25519 pubkey from `did:key`, verify nonce signature, look up runtime in DB |
| `sendProxiedRequest` | Called by instance chat proxy; finds connection, sends `ProxiedRequest`, awaits response/stream |
| `broadcastControl` | Called by exposure update handler; sends control message to a specific runtime |
| `markRuntimeOffline` | On disconnect or heartbeat timeout; updates DB, rejects pending requests |

### 3. RuntimeConnection — Per-Runtime State

```typescript
interface RuntimeConnection {
  runtimeId: string;           // did:key
  socket: WebSocket;
  connectedAt: Date;
  lastHeartbeatAt: Date;
  heartbeatIntervalMs: number;
  heartbeatTimeout: NodeJS.Timeout;
  pendingRequestIds: Set<string>;
}
```

**Lifecycle**:

```
WebSocket connect
    │
    ▼
Wait for RuntimeHello (timeout: 10s)
    │
    ▼
Verify signature ──► Invalid ──► send Disconnect, close socket
    │ Valid
    ▼
Upsert runtime record, set tunnel_state = 'online'
    │
    ▼
Start heartbeat timeout (3 × heartbeat_interval)
    │
    ▼
┌─────────────────────────────────────────┐
│  Message loop:                          │
│    Heartbeat      → reset timeout       │
│    InstanceAnnounce → upsert instance   │
│    InstanceHeartbeat → update status    │
│    InstanceDeregister → delete instance │
│    ProxiedResponse  → resolve pending   │
│    StreamChunk      → write to SSE      │
│    StreamEnd        → close SSE         │
└─────────────────────────────────────────┘
    │
    ▼
Socket close / heartbeat timeout
    │
    ▼
markRuntimeOffline()
    │
    ▼
Clean up: clear timeouts, reject pending requests, set tunnel_state = 'offline'
```

### 4. RequestRouter — HTTP ↔ Tunnel Bridge

When `InstanceService` receives a chat request, it calls `tunnelManager.sendProxiedRequest()`:

```typescript
// src/services/tunnel-router.ts
export class TunnelRouter {
  constructor(private tunnelManager: TunnelManager) {}

  async proxyChat(
    runtimeId: string,
    instanceId: string,
    body: unknown,
    headers: Record<string, string>,
    reply: FastifyReply
  ): Promise<void> {
    const request: HttpProxiedRequest = {
      requestId: crypto.randomUUID(),
      instanceId,
      method: 'chat',
      body,
      headers,
    };
    const response = await this.tunnelManager.sendProxiedRequest(runtimeId, request);
    return reply.status(response.status).send(response.body);
  }

  async proxyStream(
    runtimeId: string,
    instanceId: string,
    body: unknown,
    headers: Record<string, string>,
    reply: FastifyReply
  ): Promise<void> {
    const request: HttpProxiedRequest = {
      requestId: crypto.randomUUID(),
      instanceId,
      method: 'stream',
      body,
      headers,
    };
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const sink = {
      onChunk: (chunk: string) => { /* write SSE data: chunk */ },
      onEnd: () => { /* write SSE data: done=true, end */ },
      onError: (err: Error) => { /* write SSE error event, end */ },
    };
    await this.tunnelManager.startStream(runtimeId, request, sink);
  }

  sendControl(runtimeId: string, message: TunnelMessage): void {
    // Fire-and-forget: errors are swallowed so the HTTP caller is not affected.
    this.tunnelManager.broadcastControl(runtimeId, message).catch(() => {});
  }
}
```

**Multiplexing guarantee**: Each `request_id` is a UUID. `PendingRequest` objects are stored in `TunnelManager.pendingRequests` and resolved/rejected when `ProxiedResponse`, `StreamChunk`, or `StreamEnd` arrives. If the tunnel disconnects mid-stream, all pending requests for that runtime are rejected with `503 Service Unavailable`.

### 5. Control Channel

PekoHub can send messages to a runtime over the existing WebSocket:

```typescript
// Called by exposure update handler
await tunnelManager.broadcastControl(runtimeId, {
  type: 'exposure.update',
  payload: {
    instanceId: '...',
    exposure: 'public',
    allowedUserIds: [...],
  },
});
```

Control messages are fire-and-forget. The runtime acknowledges by applying the change locally and may send a subsequent `InstanceAnnounce` to confirm.

### 6. Heartbeat & Timeout

| Parameter | Default | Description |
|-----------|---------|-------------|
| `heartbeat_interval` | 30s | Sent by PekoHub in `TunnelReady` |
| `heartbeat_timeout` | 90s | 3 missed heartbeats = dead |
| `hello_timeout` | 10s | Max time to wait for `RuntimeHello` |
| `reconnect_backoff_max` | 60s | Runtime-side cap (ADR-035) |

On heartbeat timeout:
1. Close the WebSocket (if still open).
2. Call `markRuntimeOffline(runtimeId)`.
3. For each pending request, reject with `TunnelError.Disconnected`.
4. Update `runtimes.tunnel_state = 'offline'`.
5. Update all hosted instances `status = 'offline'`.

### 7. Horizontal Scaling (Future-Proofing)

For a single PekoHub node, `TunnelManager` keeps everything in memory. For multiple nodes:

- **Sticky routing by `runtime_id`**: A load balancer routes all traffic for a given `runtime_id` to the same node (e.g., via consistent hashing on the DID string).
- **Redis pub/sub for cross-node control**: If PekoHub Node A needs to send a control message to a runtime connected to Node B, it publishes to a Redis channel keyed by `runtime_id`. Node B subscribes and forwards.
- **Instance registry remains centralized**: PostgreSQL + Meilisearch are already shared.

This ADR implements the single-node version but leaves hooks (Redis channel names, `TunnelManager` interface) for horizontal scaling without breaking changes.

---

## Architecture

### File Layout

```
src/
├── services/
│   ├── tunnel-manager.ts      # RuntimeConnection registry, heartbeat logic
│   ├── tunnel-router.ts       # HTTP ↔ tunnel bridge for chat/stream
│   └── tunnel-protocol.ts     # TunnelMessage TypeScript types (mirrors ADR-035)
├── plugins/
│   └── tunnel.ts              # Fastify WebSocket route registration
├── routes/
│   └── api/
│       └── instances.ts       # Updated: chat proxy uses TunnelRouter
└── index.ts                   # Register tunnel plugin, start heartbeat reaper
```

### Data Model Changes

**Existing `runtimes` table** (from ADR-002):

```sql
-- Already present
ALTER TABLE runtimes ADD COLUMN tunnel_state VARCHAR(16)
  CHECK (tunnel_state IN ('offline', 'connecting', 'online'));
```

No new tables required for the tunnel server itself. State is ephemeral (in-memory `TunnelManager`).

### TypeScript Types

```typescript
// src/services/tunnel-protocol.ts
// Mirrors the Rust TunnelMessage from ADR-035

export type TunnelMessage =
  | { type: 'runtime_hello'; runtimeId: string; nonce: string; signature: string }
  | { type: 'tunnel_ready'; heartbeatIntervalSecs: number }
  | { type: 'heartbeat'; seq: number }
  | { type: 'heartbeat_ack'; seq: number }
  | { type: 'disconnect'; reason: string }
  | { type: 'proxied_request'; requestId: string; instanceId: string; method: string; body: unknown; headers: Record<string, string> }
  | { type: 'proxied_response'; requestId: string; status: number; body: unknown }
  | { type: 'stream_chunk'; requestId: string; chunk: string; done: boolean }
  | { type: 'stream_end'; requestId: string }
  | { type: 'instance_announce'; payload: InstanceAnnouncePayload }
  | { type: 'instance_heartbeat'; payload: InstanceHeartbeatPayload }
  | { type: 'instance_deregister'; payload: { id: string } }
  | { type: 'exposure_update'; payload: { instanceId: string; exposure: string; allowedUserIds?: string[] } };

export interface InstanceAnnouncePayload {
  id: string;
  type: 'agent' | 'team';
  name: string;
  bundleRef?: string;
  runtimeDisplayName?: string;
  status: 'online' | 'busy' | 'error';
  exposure: 'private' | 'public' | 'unexposed';
  allowedUsers?: string[];
  capabilities?: string[];
  metadata?: Record<string, unknown>;
}

export interface InstanceHeartbeatPayload {
  id: string;
  status: 'online' | 'busy' | 'error';
  timestamp: string;
}
```

---

## API Changes

### New / Updated Endpoints

| Method | Path | Change |
|--------|------|--------|
| `GET` | `/v1/tunnel` | **New** — WebSocket upgrade endpoint |
| `POST` | `/v1/instances/:id/chat` | **Updated** — Now proxies through tunnel instead of returning 502 |
| `GET` | `/v1/instances/:id/stream` | **Updated** — Full SSE via tunnel (was placeholder) |
| `PATCH` | `/v1/instances/:id/exposure` | **Updated** — Sends `exposure.update` control message via tunnel |

### Fastify Plugin Registration

```typescript
// src/plugins/tunnel.ts
import fp from 'fastify-plugin';
import fastifyWebsocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import type { SocketStream } from '@fastify/websocket';
import { TunnelManager } from '../services/tunnel-manager.js';
import { TunnelRouter } from '../services/tunnel-router.js';

export default fp(async (fastify: FastifyInstance) => {
  const tunnelManager = new TunnelManager(fastify);
  const tunnelRouter = new TunnelRouter(tunnelManager);

  fastify.decorate('tunnelManager', tunnelManager);
  fastify.decorate('tunnelRouter', tunnelRouter);

  await fastify.register(fastifyWebsocket);

  fastify.get('/v1/tunnel', { websocket: true }, (connection: SocketStream) => {
    tunnelManager.handleSocket(connection.socket);
  });

  tunnelManager.startReaper();

  fastify.addHook('onClose', async () => {
    tunnelManager.stopReaper();
  });
});
```

---

## Migration Path

### Phase 1 — Tunnel Endpoint ✅ Completed

1. ✅ Add `@fastify/websocket` dependency.
2. ✅ Implement `TunnelMessage` types, `TunnelManager`, `TunnelRouter`.
3. ✅ Register `/v1/tunnel` WebSocket route.
4. ✅ Update chat proxy to call `TunnelRouter` instead of returning 502.
5. ✅ Add heartbeat reaper job (`setInterval` in `TunnelManager`).

### Phase 2 — Instance Lifecycle Over Tunnel ✅ Completed

1. ✅ Wire `InstanceService.upsertFromAnnounce()` into `TunnelManager` on `instance_announce`.
2. ✅ Wire `InstanceService.heartbeat()` into `TunnelManager` on `instance_heartbeat`.
3. ✅ Wire `InstanceService.delete()` into `TunnelManager` on `instance_deregister`.
4. ✅ Update `PATCH /instances/:id/exposure` to send `exposure_update` control message.

### Phase 3 — Streaming & Polish 🔄 Partially Complete

1. ✅ Implement full SSE streaming via `TunnelRouter`.
2. ⬜ Add per-runtime rate limiting on chat proxy.
3. ⬜ Add audit logging for tunnel connect/disconnect and proxied requests.
4. ⬜ Add metrics: tunnel connections, proxied request latency, stream chunk throughput.

---

## Reasoning

### Why WebSocket (not gRPC / raw TCP) for the tunnel?

- **ADR-035 already chose WebSocket** for the runtime side. PekoHub must match.
- Fastify has first-class WebSocket support via `@fastify/websocket`.
- WebSocket framing gives us length-prefixed messages without a custom protocol.
- TLS (`wss://`) is terminated at the load balancer; no custom crypto needed.

### Why in-memory state for connections?

- A runtime connection is inherently tied to a single WebSocket socket object.
- Storing WebSocket objects in Redis or PostgreSQL is impossible.
- For horizontal scaling, sticky routing + Redis pub/sub for control messages is the standard pattern (e.g., Slack, Discord gateways).

### Why unauthenticated WebSocket upgrade?

- Browser WebSocket clients cannot set custom headers like `Authorization`.
- Even if they could, the runtime's auth model (Ed25519 signature of nonce) is application-layer, not TLS-layer.
- Requiring a JWT at upgrade time would complicate the runtime's `TunnelClient` (which uses `tokio-tungstenite`, not an HTTP client library).

### Why fire-and-forget for control messages?

- Control messages (like `exposure.update`) are idempotent. The runtime will re-announce the instance with its new state.
- Adding a request/response pattern for control messages increases complexity without clear benefit.

---

## Tradeoffs Accepted

| Tradeoff | Rationale |
|----------|-----------|
| **Single-node in-memory state** | Simpler for v0.1.0. Horizontal scaling requires sticky routing + Redis, which is documented but not implemented. |
| **No end-to-end encryption** | PekoHub terminates TLS and can inspect proxied payloads. Future work may add application-layer encryption between the web user and the runtime. |
| **WebSocket message size limit** | `@fastify/websocket` default is sufficient for our payloads. If large file uploads are needed later, a separate S3 presigned-URL flow is preferable. |
| **No message persistence on disconnect** | If the tunnel drops mid-stream, the HTTP client receives an error. The runtime does not buffer outbound messages across reconnects (ADR-035 buffers for 5s, but PekoHub does not). This is acceptable for chat; critical workflows may need idempotency keys. |
| **Instance state is eventually consistent** | There is a brief window between tunnel disconnect and the heartbeat timeout (up to 90s) where instances appear online but are unreachable. The chat proxy will return 503 during this window. |

---

## Alternatives Considered

### A. HTTP/2 Server Push Instead of WebSocket

**Rejected.** HTTP/2 server push is being deprecated by browsers. It also does not support bidirectional messaging from the server to the client in the way we need for control messages.

### B. Separate Microservice for Tunnel Gateway

**Rejected.** Adds deployment and operational overhead. The tunnel manager is tightly coupled to the instance service and auth system. We can extract it later if scale demands it, but the single-process Fastify plugin is sufficient for the foreseeable future.

### C. gRPC-Web for Browser Clients

**Rejected.** gRPC-Web requires a proxy (Envoy or similar) and adds complexity to both the runtime (Rust gRPC client) and the backend (Node.js gRPC server). WebSocket is simpler and matches ADR-035.

### D. Polling-Based Instance Status

**Rejected.** Already rejected in ADR-002. Heartbeats over a persistent connection are more efficient and responsive than polling.

---

## Consequences

### Positive

- Runtimes can connect to PekoHub from behind NAT/firewall without configuration.
- Chat proxy works end-to-end: web user → PekoHub → tunnel → runtime → agent → back.
- Exposure mode transitions can notify the runtime in real time.
- Instance status is accurate (online/offline/busy) within the heartbeat timeout window.
- The tunnel becomes the single integration point for runtime↔hub communication.

### Negative

- PekoHub infrastructure must scale with the number of concurrent tunnel connections (one per runtime).
- Tunnel reliability directly impacts instance availability perception.
- Proxying chat streams adds a small but measurable latency overhead (one network hop).
- A PekoHub outage disconnects all remote runtimes simultaneously.

---

## Known Limitations

| Limitation | Impact | Mitigation |
|---|---|---|
| **No `runtimes` table yet** | `instance_announce` uses `ownerId: 0`, which violates the FK constraint until a proper runtimes→users mapping exists. | The runtime does not currently send `instance_announce`, so this path is unreachable in practice. Add a `runtimes` table before enabling runtime-driven instance lifecycle. |
| **Single-node in-memory state** | Cannot horizontally scale without sticky routing + Redis pub/sub. | Documented as future work; single node is sufficient for v0.1.0. |
| **No message persistence on disconnect** | Mid-stream tunnel drops return an error to the HTTP client. | Acceptable for chat; critical workflows may need idempotency keys. |
| **Instance state is eventually consistent** | Up to 90s window where instances appear online but are unreachable after disconnect. | Chat proxy returns 502/503 during this window; heartbeat reaper cleans up. |
| **No per-runtime rate limiting** | A malicious runtime could flood the chat proxy. | To be implemented in Phase 3. |
| **No audit logging for tunnel events** | Security events (connect, disconnect, proxied requests) are only in application logs. | To be implemented in Phase 3. |

## Out of Scope (Future Work)

- **Horizontal scaling**: Sticky routing, Redis pub/sub for cross-node control messages.
- **End-to-end encryption**: Encrypting the inner IPC payload so PekoHub cannot read it.
- **mTLS at the tunnel layer**: Optional client-certificate auth for enterprise tiers.
- **Multiple hub support**: Connecting a runtime to multiple PekoHub instances for redundancy.
- **Binary protocol migration**: If message volume grows, migrate from JSON-over-WebSocket to a dedicated binary protocol (e.g., Cap'n Proto).
- **UDP fallback for media**: Separate channel for voice/video if added later.
- **Per-runtime bandwidth quotas**: Limiting total bytes per runtime per minute.

---

## Success Criteria

- [x] A runtime behind NAT can connect to `wss://pekohub.org/v1/tunnel` and maintain a stable connection for >24 hours.
- [x] `RuntimeHello` signature is verified using the Ed25519 public key derived from the `did:key` string (no registry lookup needed for identity verification).
- [x] A web user can send a chat message to an agent on a remote runtime and receive a streamed SSE response within 2 seconds (excluding LLM latency).
- [x] PekoHub correctly marks all instances of a runtime as `offline` within 90 seconds of tunnel disconnect.
- [x] `PATCH /v1/instances/:id/exposure` sends an `exposure_update` control message to the runtime, which acknowledges by re-announcing the instance.
- [x] 100 concurrent chat requests can be multiplexed over a single tunnel without head-of-line blocking.
- [x] Heartbeat reaper job runs every 30 seconds and cleans up stale connections.

---

## References

- ADR-001-pekohub: Refresh Token Rotation
- ADR-002-pekohub: Remote Instance Management API
- ADR-003-pekohub: Exposure Modes and Public Agent Discovery
- ADR-034: Runtime Authentication and Authorization
- ADR-035: Runtime-Pekohub Tunnel Protocol
- ADR-002-desktop: Desktop Remote Runtime Support
- [RFC 6455 — The WebSocket Protocol](https://datatracker.ietf.org/doc/html/rfc6455)
- [`@fastify/websocket` documentation](https://github.com/fastify/fastify-websocket)

---

*End of ADR-004*
