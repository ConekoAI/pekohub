# ADR-002: Remote Instance Management API

| Field | Value |
|-------|-------|
| **Status** | Implemented |
| **Date** | 2026-06-07 |
| **Depends On** | ADR-001-pekohub (Refresh Token Rotation), ADR-035 (Tunnel Protocol) |
| **Related** | ADR-037 (Exposure Modes), ADR-033 (Ownership & Permission Model) |

> **⚠️ Historical note (post-#21 / ADR-041 / ADR-042):** This ADR predates the
> "principal-as-container" clean break. References to an instance `type` of
> `'agent' | 'team'` are **superseded** — `instances.type` is now `'principal'`
> only (`team` rows were rewritten by migration `0008b_replace_team_with_principal.sql`).
> The runtime dropped the `Team` subject variant entirely; see
> [ADR-042](./ADR-042-principal-as-container-v2.md) for the current data model.
> The text below is retained as the original decision record.

---

## Context

PekoHub is a public registry for Pekobot agents, teams, and extensions. It is implemented as a Node.js/Fastify backend backed by PostgreSQL, Meilisearch, and S3 storage. As the ecosystem grows, users increasingly run agents and teams on their own local or remote "peko runtimes" (e.g., desktop applications, servers, or edge devices). To bridge these runtimes with the public registry, PekoHub must expose APIs that allow users to discover, interact with, and manage running instances without requiring direct network access to the runtime itself.

This ADR defines the architecture for a **Remote Instance Management API** — a set of endpoints, data models, and tunnel-mediated flows that let PekoHub act as a proxy and registry for live agent/team instances.

---

## Problem Statement

1. **Discovery Gap**: There is no way for a PekoHub user to see which agents or teams they (or others) currently have running across different runtimes.
2. **Access Barrier**: Runtimes are often behind NATs or firewalls. Users cannot directly connect to an instance to chat with an agent or trigger a team workflow.
3. **No Centralized Lifecycle Management**: Instance registration, status tracking, deregistration, and exposure control are currently handled ad-hoc or not at all.
4. **Security & Permissions**: Exposing an instance to the public or to specific peers requires a unified permission model integrated with PekoHub's existing auth system.

We need a centralized, secure, and scalable mechanism for:
- Registering and tracking instances.
- Controlling exposure (private, public, unexposed).
- Proxying chat and stream requests from users to runtimes via the existing tunnel.

---

## Decision

### 1. Instance Abstraction

An **instance** represents a single running agent or team on a specific runtime. It is the canonical unit of remote management in PekoHub.

Key properties:
- Uniquely identified by a UUID.
- Bound to a PekoHub user (`owner_id`) and a runtime (`runtime_id`).
- Carries a `status` reflecting runtime-reported health.
- Carries an `exposure` level controlling who can interact with it.
- Stores `capabilities` (extensions) and opaque `metadata` for extensibility.

### 2. Tunnel-Driven Lifecycle

All runtime-to-hub communication for instance management happens over the existing tunnel protocol (ADR-035). There is no separate HTTP API exposed by the runtime. This keeps runtime firewall requirements minimal and reuses the authenticated, persistent connection already established by the tunnel.

### 3. PekoHub as a Proxy

All user-to-instance interactions (chat, streams) are proxied through PekoHub. Users never connect directly to the runtime. PekoHub validates auth, checks exposure/permissions, forwards the request through the tunnel, and relays the response (including SSE streams) back to the user.

### 4. Status as Event-Driven State

Instance status is derived from tunnel events (`InstanceAnnounce`, `InstanceHeartbeat`, disconnect) rather than polling. This reduces latency and database load.

---

## Architecture

### Instance Model

```typescript
interface Instance {
  id: string;                    // UUID
  type: 'agent' | 'team';
  name: string;                  // Agent/team name
  owner_id: string;              // PekoHub user ID
  runtime_id: string;            // Runtime DID
  runtime_display_name: string;  // e.g., "MacBook Pro"
  bundle_ref: string;            // e.g., "alice/my-agent:v1.2" or null if local-only
  status: 'online' | 'offline' | 'busy' | 'error';
  exposure: 'private' | 'public' | 'unexposed';
  allowed_users: string[];       // For private exposure
  last_seen_at: Date;
  created_at: Date;
  capabilities: string[];        // Extensions available
  metadata: Record<string, any>;
}
```

### Tunnel Messages

The tunnel protocol (ADR-035) is extended with the following message types for instance management:

```typescript
// Runtime -> Hub
interface InstanceAnnounce {
  type: 'instance_announce';
  payload: {
    id: string;
    type: 'agent' | 'team';
    name: string;
    bundle_ref?: string;
    runtime_display_name?: string;
    status: 'online' | 'busy' | 'error';
    exposure: 'private' | 'public' | 'unexposed';
    allowed_users?: string[];
    capabilities?: string[];
    metadata?: Record<string, any>;
  };
}

// Runtime -> Hub (periodic)
interface InstanceHeartbeat {
  type: 'instance_heartbeat';
  payload: {
    id: string;
    status: 'online' | 'busy' | 'error';
    timestamp: string; // ISO 8601
  };
}

// Runtime -> Hub
interface InstanceDeregister {
  type: 'instance_deregister';
  payload: {
    id: string;
  };
}

// Hub -> Runtime (proxied user request)
interface ProxiedRequest {
  type: 'proxied_request';
  payload: {
    request_id: string;
    instance_id: string;
    method: 'chat' | 'stream';
    body: unknown;
    headers: Record<string, string>;
  };
}

// Runtime -> Hub (proxied response)
interface ProxiedResponse {
  type: 'proxied_response';
  payload: {
    request_id: string;
    status: number;
    body: unknown;
  };
}

// Runtime -> Hub (SSE stream chunk)
interface StreamChunk {
  type: 'stream_chunk';
  payload: {
    request_id: string;
    chunk: string;
    done: boolean;
  };
}
```

### Runtime Registration Flow

```
┌─────────┐                     ┌──────────┐                     ┌─────────┐
│ Runtime │                     │  Tunnel  │                     │ PekoHub │
└────┬────┘                     └────┬─────┘                     └────┬────┘
     │                               │                                │
     │  1. Connect & authenticate    │                                │
     │──────────────────────────────>│                                │
     │                               │  2. Auth OK                    │
     │                               │<───────────────────────────────│
     │                               │                                │
     │  3. InstanceAnnounce (agent)  │                                │
     │──────────────────────────────>│  4. Upsert instance record     │
     │                               │───────────────────────────────>│
     │                               │                                │
     │  5. InstanceHeartbeat         │  6. Update last_seen_at        │
     │──────────────────────────────>│  7. Update status              │
     │         (every N sec)         │───────────────────────────────>│
     │                               │                                │
```

### Chat Proxy Flow

```
┌───────┐                     ┌─────────┐                     ┌──────────┐                     ┌─────────┐
│ User  │                     │ PekoHub │                     │  Tunnel  │                     │ Runtime │
└───┬───┘                     └────┬────┘                     └────┬─────┘                     └────┬────┘
    │                              │                               │                                │
    │  1. POST /v1/instances/:id/chat│                               │                                │
    │  (JWT or public)             │                               │                                │
    │─────────────────────────────>│                               │                                │
    │                              │  2. Validate auth & exposure  │                                │
    │                              │  3. Check allowed_users       │                                │
    │                              │                               │                                │
    │                              │  4. ProxiedRequest            │                                │
    │                              │──────────────────────────────>│                                │
    │                              │                               │  5. Route to instance          │
    │                              │                               │───────────────────────────────>│
    │                              │                               │                                │
    │                              │  6. ProxiedResponse /         │  7. Response / StreamChunk     │
    │                              │  7. StreamChunk (SSE)         │<───────────────────────────────│
    │                              │<──────────────────────────────│                                │
    │  8. SSE stream or JSON body  │                               │                                │
    │<─────────────────────────────│                               │                                │
```

### Status Tracking

Status transitions are driven exclusively by tunnel events:

| Event | Resulting Status | Notes |
|-------|-----------------|-------|
| `InstanceAnnounce` with `status: online` | `online` | Initial registration or recovery |
| `InstanceHeartbeat` with `status: online` | `online` | Refreshes `last_seen_at` |
| `InstanceHeartbeat` with `status: busy` | `busy` | Agent is processing a request |
| `InstanceHeartbeat` with `status: error` | `error` | Runtime reported an error state |
| Tunnel disconnect / heartbeat timeout | `offline` | Configurable timeout (default 60s) |
| `InstanceDeregister` | Record deleted | Clean shutdown |

A background job (or tunnel manager hook) marks instances `offline` if `last_seen_at` exceeds the heartbeat timeout.

---

## Database Schema

Using Drizzle ORM with PostgreSQL:

```typescript
import { pgTable, uuid, varchar, integer, timestamp, jsonb } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './users'; // existing users table

export const instances = pgTable('instances', {
  id: uuid('id').primaryKey().defaultRandom(),
  type: varchar('type', { length: 10 }).notNull(), // 'agent' | 'team'
  name: varchar('name', { length: 255 }).notNull(),
  ownerId: integer('owner_id').notNull().references(() => users.id),
  runtimeId: varchar('runtime_id', { length: 255 }).notNull(),
  runtimeDisplayName: varchar('runtime_display_name', { length: 255 }),
  bundleRef: varchar('bundle_ref', { length: 255 }),
  status: varchar('status', { length: 20 }).notNull().default('offline'),
  exposure: varchar('exposure', { length: 20 }).notNull().default('unexposed'),
  allowedUsers: jsonb('allowed_users').default('[]'),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  capabilities: jsonb('capabilities').default('[]'),
  metadata: jsonb('metadata').default('{}'),
});

export const instanceRelations = relations(instances, ({ one }) => ({
  owner: one(users, { fields: [instances.ownerId], references: [users.id] }),
}));
```

### Indexes

```typescript
// drizzle migration or raw SQL
// Recommended indexes for query patterns:
// - List my instances: WHERE owner_id = ?
// - Find by runtime: WHERE runtime_id = ?
// - Public listings: WHERE exposure = 'public' AND status = 'online'
// - Heartbeat cleanup: WHERE last_seen_at < ?
```

```sql
CREATE INDEX idx_instances_owner_id ON instances(owner_id);
CREATE INDEX idx_instances_runtime_id ON instances(runtime_id);
CREATE INDEX idx_instances_exposure_status ON instances(exposure, status) WHERE exposure = 'public';
CREATE INDEX idx_instances_last_seen_at ON instances(last_seen_at);
```

---

## API Design

All endpoints are implemented as Fastify routes. Authentication uses the existing JWT middleware (ADR-001-pekohub). Public endpoints skip JWT but enforce instance-level exposure checks.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/v1/instances` | JWT | List instances owned by the authenticated user. Supports filtering by `status`, `type`, and `runtime_id`. |
| `GET` | `/v1/instances/:id` | JWT | Get full details of a specific instance. Must be owner or in `allowed_users`. |
| `POST` | `/v1/instances` | JWT | Register a new instance. Called by the runtime via tunnel proxy, or directly for testing. |
| `PATCH` | `/v1/instances/:id` | JWT | Update mutable fields: `name`, `exposure`, `allowed_users`, `runtime_display_name`, `metadata`. |
| `DELETE` | `/v1/instances/:id` | JWT | Deregister an instance. Also sent to runtime via tunnel if connected. |
| `POST` | `/v1/instances/:id/chat` | JWT or Public* | Send a message to an agent instance. Returns a chat response or initiates an SSE stream. |
| `GET` | `/v1/instances/:id/stream` | JWT or Public* | SSE stream for real-time chat responses. |
| `GET` | `/v1/instances/public` | None | List all publicly exposed, online instances. Paginated. |
| `GET` | `/v1/instances/public/search` | None | Search public instances by name, capability, or bundle ref. Backed by Meilisearch. |

\* Public endpoints check `instance.exposure === 'public'`. For `private` instances, the caller must present a valid JWT and be either the owner or listed in `allowed_users`.

### Route Example (Fastify)

```typescript
import { FastifyInstance } from 'fastify';

export async function instanceRoutes(app: FastifyInstance) {
  // List my instances
  app.get('/v1/instances', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { user } = request;
    const { status, type, runtime_id } = request.query as Record<string, string>;
    // ... query instances table, filter by ownerId + optional filters
    return { data: instances, total };
  });

  // Get instance details
  app.get('/v1/instances/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    // ... fetch instance, check ownership or allowed_users
    return instance;
  });

  // Update instance
  app.patch('/v1/instances/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const updates = request.body as Partial<Instance>;
    // ... validate updates, persist
    return updatedInstance;
  });

  // Chat proxy
  app.post('/v1/instances/:id/chat', async (request, reply) => {
    const { id } = request.params as { id: string };
    const instance = await getInstance(id);

    // Auth check
    if (instance.exposure === 'private') {
      await request.jwtVerify();
      const user = request.user as { id: string };
      if (instance.owner_id !== user.id && !instance.allowed_users.includes(user.id)) {
        return reply.code(403).send({ error: 'Forbidden' });
      }
    }

    // Proxy through tunnel
    const response = await tunnelManager.sendProxiedRequest(instance.runtime_id, {
      instance_id: id,
      method: 'chat',
      body: request.body,
      headers: request.headers as Record<string, string>,
    });

    return reply.code(response.status).send(response.body);
  });
}
```

---

## Implementation Progress

### Completed

| # | Item | Status | Notes |
|---|------|--------|-------|
| 1 | **Database** | ✅ Done | `instances` table added via Drizzle migration `0004_add_instances_table.sql`. Foreign key to `users(id)` with cascade delete. |
| 2 | **Tunnel Protocol** | 🔄 Stubbed | Message types (`InstanceAnnounce`, `InstanceHeartbeat`, `InstanceDeregister`, `ProxiedRequest`, `ProxiedResponse`, `StreamChunk`) are defined in `InstanceService`. The tunnel manager integration is a TODO pending ADR-035 runtime work. |
| 3 | **Runtime** | ⏳ Pending | Runtime changes are out of scope for this backend-only implementation. |
| 4 | **PekoHub Backend** | ✅ Done | Fastify routes (`src/routes/api/instances.ts`) and service layer (`src/services/instances.ts`) fully implemented. |
| 5 | **Meilisearch** | ✅ Done | `instances` index created in `searchPlugin`. `indexInstance` / `searchInstances` / `deleteInstance` methods implemented. Sync on create/update/delete. |
| 6 | **Rate Limiting** | 🔄 Partial | Global rate limits apply. Per-runtime/instance/public-IP scoped rules are deferred. |
| 7 | **Gradual Rollout** | ✅ Ready | All three exposure modes (`private`, `public`, `unexposed`) are implemented. Public exposure can be enabled via the `exposure` field. |

### Files Added / Modified

- `src/db/schema.ts` — Added `instances` table and relations
- `src/services/instances.ts` — New instance service (CRUD, heartbeat, proxy)
- `src/routes/api/instances.ts` — New Fastify routes
- `src/plugins/search.ts` — Added `instances` Meilisearch index and methods
- `src/index.ts` — Registered instance routes
- `drizzle/0004_add_instances_table.sql` — Migration
- `tests/integration/instances.test.ts` — 17 integration tests
- `tests/fixtures/db.ts`, `app.ts`, `factories.ts` — Test fixture updates

## Migration Path

1. **Database**: Run `drizzle-kit migrate` to apply `0004_add_instances_table.sql`.
2. **Tunnel Protocol**: Wire the tunnel manager to call `instanceService.upsertFromAnnounce()`, `instanceService.heartbeat()`, `instanceService.delete()`, and `instanceService.resolveProxiedResponse()` / `rejectProxiedRequest()`.
3. **Runtime**: Update the runtime to send `InstanceAnnounce` after tunnel auth and `InstanceHeartbeat` on a configurable interval (default 30s).
4. **Rate Limiting**: Add custom rate-limit rules for `/v1/instances/:id/chat` scoped by runtime ID, instance ID, and public IP.
5. **Gradual Rollout**: Start with `exposure: 'private'` only. Enable `public` after auditing and load testing the proxy path.

---

## Reasoning

- **Why a unified Instance model?** It provides a single source of truth for runtime-reported state, ownership, and exposure. This simplifies both the user-facing API and internal tunnel bookkeeping.
- **Why tunnel-driven?** Runtimes are often behind restrictive networks. Requiring the runtime to expose an HTTP server would break in most home/office networks. The tunnel (already required for other features) solves this natively.
- **Why PekoHub as proxy?** It centralizes auth, rate limiting, logging, and audit trails. It also allows us to add caching, request transformation, or analytics later without touching runtimes.
- **Why event-driven status?** Polling every instance would create unnecessary database and network load. Heartbeats over an existing persistent connection are cheap and accurate.
- **Why SSE for streams?** SSE is simple, works over HTTP, and integrates cleanly with Fastify. It avoids the complexity of WebSockets for a primarily unidirectional server-to-client stream.

---

## Tradeoffs Accepted

| Tradeoff | Rationale |
|----------|-----------|
| **PekoHub is on the critical path for all instance traffic** | Centralized proxying adds latency and hub load, but is necessary for auth, audit, and NAT traversal. We can optimize with connection pooling and edge caching later. |
| **Runtime must maintain tunnel connection** | If the tunnel drops, the instance appears offline even if the agent is healthy. This is acceptable because the tunnel is the only reliable channel for proxying. |
| **JSONB for `capabilities`, `allowed_users`, and `metadata`** | Simplifies schema evolution. For `allowed_users`, a GIN index can be added if membership checks become a bottleneck. |
| **No direct runtime-to-runtime communication** | All traffic flows through PekoHub. This is simpler to secure but may become a bottleneck for high-frequency use cases. |
| **Instance IDs are UUIDs, not scoped to runtime** | This makes URLs stable and allows runtime migration, but requires global uniqueness. UUID v4 is sufficient. |

---

## Alternatives Considered

### A. Runtime exposes its own HTTP server
- **Rejected**: Requires port forwarding, dynamic DNS, or a reverse tunnel anyway. Reintroduces the NAT/firewall problem the tunnel already solves.

### B. WebSockets instead of SSE for streaming
- **Rejected**: SSE is sufficient for unidirectional server-to-client streams and integrates more naturally with Fastify and existing HTTP middleware. WebSockets would add connection management complexity.

### C. Separate microservice for instance management
- **Rejected**: Adds deployment and operational overhead. The instance API is tightly coupled to the tunnel manager and auth system already in PekoHub. We can extract later if scale demands it.

### D. Polling-based status instead of heartbeats
- **Rejected**: Higher latency and database load. Heartbeats over the persistent tunnel are more efficient and responsive.

---

## Consequences

### Positive
- Users can discover and interact with remote agents/teams through a single, consistent API.
- Runtimes do not need public IPs or open ports.
- Exposure and permissions are centralized and auditable.
- The tunnel protocol becomes the single integration point for runtime features, reducing fragmentation.

### Negative
- PekoHub infrastructure must scale with instance and chat traffic.
- Tunnel reliability directly impacts instance availability perception.
- Proxying chat streams adds a small but measurable latency overhead.

### Risks
- **Tunnel saturation**: High message volume between runtimes and hub could saturate tunnel connections. Mitigation: binary framing, backpressure, and horizontal scaling of tunnel gateways.
- **Stale instance records**: If a runtime crashes without sending `InstanceDeregister`, the record lingers as `offline` until a background cleanup job runs. Mitigation: heartbeat timeout + periodic reaper.

---

## Known Limitations

| Limitation | Impact | Mitigation / Plan |
|------------|--------|-------------------|
| **Tunnel manager not wired** | Chat proxy returns `502 Instance unreachable` because `sendProxiedRequest` has no transport layer. | The `InstanceService` exposes `resolveProxiedResponse` / `rejectProxiedRequest` hooks. The tunnel manager (ADR-035) should call these when `proxied_response` or `stream_chunk` messages arrive. |
| **SSE stream is a placeholder** | `GET /v1/instances/:id/stream` returns a single `done=true` chunk and closes. | Full streaming requires tunnel manager integration to relay `StreamChunk` messages into the SSE response. |
| **No background heartbeat reaper** | Stale instances remain `offline` indefinitely unless the tunnel disconnect hook runs. | `InstanceService.markOfflineIfStale()` is implemented but not scheduled. Add a `Scheduler` job in `src/index.ts` (follow the GC job pattern). |
| **Rate limiting is global only** | No per-runtime, per-instance, or per-public-IP rate limits on chat endpoints yet. | Extend the existing `@fastify/rate-limit` configuration or add custom hooks scoped to `request.params.id` and `request.ip`. |
| **No audit logging for instance ops** | Instance CRUD and chat proxy events are not written to the audit log. | Add `auditService` calls in `instanceRoutes` for create, update, delete, and chat proxy actions. |
| **Public search index may drift** | If Meilisearch is unavailable during an update, the index can become inconsistent. | Add a background sync job or retry queue for failed index operations. |

## Out of Scope (Future Work)

The following are explicitly deferred to future ADRs:

- **Instance metrics and observability**: CPU, memory, token usage. Will require new tunnel messages and a time-series store.
- **Team workflow triggers**: The current API focuses on agent chat. Team-specific endpoints (e.g., trigger workflow, view run history) will be added later.
- **Instance scaling / auto-shutdown**: No support for spawning or terminating instances from PekoHub.
- **Custom domains for public instances**: Public instances are accessed via `pekohub.dev/v1/instances/:id`. Vanity URLs are future work.
- **Billing / quotas for public instance usage**: Rate limits are in place, but no usage-based metering yet.
- **Real-time collaborative chat**: Multiple users chatting with the same agent instance simultaneously. The proxy layer supports it, but explicit session management is not defined here.

---

## Success Criteria

1. A runtime can announce an instance, and it appears in the owner's instance list within 1 second.
2. A user can send a chat message to a private instance and receive a response within 2 seconds (excluding runtime processing time).
3. Public instances are listable and searchable by unauthenticated users.
4. Instance status accurately reflects runtime state with a maximum staleness of 60 seconds.
5. Rate limits are enforced at all three scopes (runtime, instance, public IP).
6. No direct runtime HTTP exposure is required.

---

## References

- ADR-001-pekohub: Refresh Token Rotation
- ADR-035: Tunnel Protocol
- ADR-037: Exposure Modes
- ADR-033: Ownership & Permission Model
- [Drizzle ORM Documentation](https://orm.drizzle.team/)
- [Fastify Documentation](https://fastify.dev/)
- [Server-Sent Events (SSE)](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events)
