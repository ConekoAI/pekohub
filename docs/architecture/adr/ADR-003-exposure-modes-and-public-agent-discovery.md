# ADR-003: Exposure Modes and Public Agent Discovery

- **Status:** Proposed
- **Date:** 2026-06-07
- **Depends On:** ADR-002 (Remote Instance Management API), ADR-035 (Tunnel Protocol)
- **Related:** ADR-033 (Ownership & Permission Model), ADR-036 (Remote Instance Management)

---

## Context

PekoHub is a public registry for Pekobot agents, teams, and extensions. With the introduction of remote instance management (ADR-002) and the tunnel protocol (ADR-035), users can already connect their locally-running agents to PekoHub for personal access. The next logical step is to let users expose these connected instances to others—either privately to a controlled set of users, or publicly to the entire internet.

This ADR defines the exposure modes, state transitions, public discovery mechanisms, and the supporting infrastructure required to make agent sharing safe, discoverable, and scalable.

---

## Problem Statement

We need to answer the following questions:

1. How does an owner control who can access their running agent instance?
2. What are the valid exposure states, and how do transitions between them work?
3. How do public agents get discovered without compromising privacy or security?
4. What abuse-prevention and analytics mechanisms are needed for public exposure?
5. Where do we leave hooks for future monetization without over-engineering today?

---

## Decision

### 1. Three Exposure Modes

Every agent instance managed through PekoHub has an `exposure` field with one of three modes:

| Mode | Description |
|------|-------------|
| `unexposed` | Default. Agent is only accessible on the host runtime. No tunnel, no remote access. |
| `private` | Accessible via PekoHub, but only to the owner and explicitly allowed users. Authentication required. |
| `public` | Accessible to anyone without authentication. Like a public chatbot or business service. |

The exposure mode is stored on the instance record in PekoHub and synchronized with the runtime via the tunnel control channel.

### 2. Exposure Mode Transitions

```
Unexposed → Private:  Owner toggles in UI. Runtime opens tunnel (if not already open).
                       PekoHub creates/updates instance record with exposure=private.

Unexposed → Public:   Same as above, but with exposure=public.

Private → Public:     Owner changes exposure setting. No runtime reconnection needed.
                       PekoHub updates the record; public discovery indexes it immediately.

Public → Private:     Owner changes exposure. Existing public URLs return 403.
                       Discovery indexes remove the instance within seconds.

Private → Unexposed:  Owner changes exposure. Tunnel may stay open for other instances.
                       Runtime stops announcing this instance.

Public → Unexposed:   Same as Private → Unexposed.
```

All transitions are initiated by the owner through the PekoHub UI or API. The runtime receives the new exposure mode over the tunnel control channel and adjusts its local behavior accordingly.

### 3. Private Exposure Details

- **Allowed Users**: Identified by PekoHub user ID. The owner can add or remove users via the UI or API.
- **Discovery**: Allowed users see the instance in their "Shared with Me" list on the PekoHub dashboard.
- **Authentication**: Every request to a private instance requires a valid Bearer JWT. No anonymous access is permitted.
- **Authorization**: PekoHub validates the JWT, checks the user's ID against the instance's `allowedUserIds` list, and only then proxies the request through the tunnel.

### 4. Public Exposure Details

- **Authentication**: Not required for chat interaction.
- **Rate Limiting**: Applied by IP address, with stricter limits than authenticated users.
- **Public Profile**: Owner can set a `publicName`, `description`, and `tags`.
- **Discovery**: Public instances appear in search, categories, trending, new, and featured listings.
- **Optional Terms of Service**: Owner can require visitors to acknowledge a custom ToS before chatting.
- **Optional Quotas**: Owner can set daily/weekly usage quotas (enforced at the PekoHub proxy layer).

### 5. Public Discovery

Public discovery is powered by **Meilisearch** and a set of curated feeds:

- **Search**: Full-text search over `publicName`, `description`, and `tags`.
- **Categories**: Predefined taxonomy (Productivity, Coding, Creative, Business, Entertainment, Education, etc.).
- **Trending**: Instances ranked by recent chat volume (anonymized, aggregated over a 24-hour window).
- **New**: Recently published public instances, sorted by `publishedAt`.
- **Featured**: Curated by the PekoHub team via a manual `featured` flag.

### 6. Public Instance Page

- **URL**: `https://pekohub.org/agents/:owner/:agent-name`
- **Content**:
  - Public name, description, owner profile card
  - Capabilities list (derived from agent manifest)
  - Real-time status indicator (online / offline / busy)
  - Embedded chat interface (simplified version of the full peko-desktop UI)
- **Offline State**: If the runtime is disconnected, the page shows "This agent is currently offline" with an option to notify the visitor when it comes back.

### 7. Security & Abuse Prevention

- **Execution Boundary**: Public instances run in the owner's local runtime with their filesystem and network access. PekoHub does **not** execute agent code; it only proxies messages through the tunnel.
- **Sandboxing**: Owners are responsible for leveraging existing peko-runtime sandbox features (e.g., restricted filesystem, network policies).
- **Reporting**: Every public instance page includes a "Report" button. Reported agents are reviewed by the PekoHub moderation pipeline.
- **Delisting**: PekoHub can forcibly set an instance's exposure to `unexposed` if it violates platform terms.
- **Anti-Spam**: Public exposure requires an email-verified account.

### 8. Analytics (Privacy-Preserving)

Public instance owners have access to a dashboard showing:

- Total chat sessions
- Unique visitors (anonymized, cookie-based or IP-hashed)
- Average session length

**Important**: No per-message content is stored by PekoHub. All chat content flows through the tunnel end-to-end; PekoHub only sees metadata (timestamps, message sizes, session IDs).

### 9. Monetization Hook (Future)

This ADR documents but does not implement the following monetization concepts:

- **Paid Public Agents**: Instances that require payment before access.
- **Subscription Tiers**: Different feature levels for public instance owners.
- **Usage-Based Billing**: Billing based on message count or compute time.

Extension points are left in the schema and API to support these features later without breaking changes.

---

## Architecture

### Data Model

```typescript
// PekoHub instance record (simplified)
interface AgentInstance {
  id: string;
  ownerId: string;
  agentId: string;
  runtimeId: string;

  exposure: 'unexposed' | 'private' | 'public';
  allowedUserIds: string[];           // for private mode

  // Public profile (only relevant when exposure === 'public')
  publicName: string | null;
  description: string | null;
  tags: string[];
  category: PublicCategory | null;
  tosRequired: boolean;
  tosText: string | null;
  dailyQuota: number | null;
  weeklyQuota: number | null;

  // Discovery & curation
  publishedAt: Date | null;
  featured: boolean;

  // Monetization hooks (future)
  monetization: {
    enabled: boolean;
    pricingModel: 'free' | 'subscription' | 'usage' | null;
    priceCents: number | null;
    stripeProductId: string | null;
  };
}

type PublicCategory =
  | 'productivity'
  | 'coding'
  | 'creative'
  | 'business'
  | 'entertainment'
  | 'education'
  | 'other';
```

### Exposure State Machine

```typescript
type ExposureMode = 'unexposed' | 'private' | 'public';

interface ExposureTransition {
  from: ExposureMode;
  to: ExposureMode;
  sideEffects: SideEffect[];
}

type SideEffect =
  | { type: 'openTunnel' }
  | { type: 'closeTunnel'; onlyIfNoOtherInstances: boolean }
  | { type: 'updateDiscoveryIndex'; action: 'add' | 'remove' | 'update' }
  | { type: 'notifyRuntime'; payload: { exposure: ExposureMode } }
  | { type: 'invalidatePublicUrls' };

const VALID_TRANSITIONS: ExposureTransition[] = [
  {
    from: 'unexposed',
    to: 'private',
    sideEffects: [
      { type: 'openTunnel' },
      { type: 'notifyRuntime', payload: { exposure: 'private' } },
      { type: 'updateDiscoveryIndex', action: 'remove' }, // ensure not public
    ],
  },
  {
    from: 'unexposed',
    to: 'public',
    sideEffects: [
      { type: 'openTunnel' },
      { type: 'notifyRuntime', payload: { exposure: 'public' } },
      { type: 'updateDiscoveryIndex', action: 'add' },
    ],
  },
  {
    from: 'private',
    to: 'public',
    sideEffects: [
      { type: 'notifyRuntime', payload: { exposure: 'public' } },
      { type: 'updateDiscoveryIndex', action: 'add' },
    ],
  },
  {
    from: 'public',
    to: 'private',
    sideEffects: [
      { type: 'notifyRuntime', payload: { exposure: 'private' } },
      { type: 'updateDiscoveryIndex', action: 'remove' },
      { type: 'invalidatePublicUrls' },
    ],
  },
  {
    from: 'private',
    to: 'unexposed',
    sideEffects: [
      { type: 'notifyRuntime', payload: { exposure: 'unexposed' } },
      { type: 'closeTunnel', onlyIfNoOtherInstances: true },
    ],
  },
  {
    from: 'public',
    to: 'unexposed',
    sideEffects: [
      { type: 'notifyRuntime', payload: { exposure: 'unexposed' } },
      { type: 'updateDiscoveryIndex', action: 'remove' },
      { type: 'closeTunnel', onlyIfNoOtherInstances: true },
    ],
  },
];
```

### Tunnel Control Message

When exposure changes, PekoHub sends a control message to the runtime over the existing tunnel:

```typescript
interface TunnelControlMessage {
  type: 'exposure.update';
  payload: {
    instanceId: string;
    exposure: ExposureMode;
    allowedUserIds?: string[]; // included for private mode
  };
}
```

The runtime acknowledges and applies the change locally. It does not tear down the tunnel unless instructed to do so and no other instances require it.

---

## API Design

### Update Exposure

```typescript
// PATCH /api/v1/instances/:instanceId/exposure
interface UpdateExposureRequest {
  exposure: ExposureMode;
  allowedUserIds?: string[];      // required when exposure === 'private'
  publicProfile?: PublicProfile;  // required when exposure === 'public'
}

interface PublicProfile {
  publicName: string;
  description: string;
  tags: string[];
  category: PublicCategory;
  tosRequired?: boolean;
  tosText?: string;
  dailyQuota?: number;
  weeklyQuota?: number;
}

interface UpdateExposureResponse {
  instance: AgentInstance;
  tunnelStatus: 'opened' | 'already_open' | 'closed';
}
```

### List Shared Instances (Private Discovery)

```typescript
// GET /api/v1/me/shared-instances
interface ListSharedInstancesResponse {
  instances: Array<{
    id: string;
    ownerId: string;
    ownerName: string;
    agentName: string;
    publicName: string | null;
    status: 'online' | 'offline';
  }>;
}
```

### Public Discovery

```typescript
// GET /api/v1/discovery/search?q=productivity&category=coding&sort=trending
interface SearchPublicInstancesResponse {
  hits: Array<{
    id: string;
    publicName: string;
    description: string;
    ownerName: string;
    category: PublicCategory;
    tags: string[];
    status: 'online' | 'offline';
    publishedAt: string;
    featured: boolean;
  }>;
  total: number;
  page: number;
}

// GET /api/v1/discovery/feed/:feed
// feed ∈ { trending, new, featured }
```

### Public Instance Page Data

```typescript
// GET /api/v1/public/agents/:owner/:agentName
interface PublicInstancePageResponse {
  instance: {
    id: string;
    publicName: string;
    description: string;
    owner: {
      id: string;
      name: string;
      avatarUrl: string | null;
    };
    capabilities: string[];
    status: 'online' | 'offline';
    tosRequired: boolean;
    tosText: string | null;
  };
}
```

### Chat Proxy (Public)

```typescript
// POST /api/v1/public/agents/:owner/:agentName/chat
// Headers: X-RateLimit-Key (derived from IP)
// Body: { message: string; sessionId?: string; tosAcknowledged?: boolean }
// Response: SSE stream or JSON response (same protocol as private chat)
```

If `tosRequired` is true and `tosAcknowledged` is false, the endpoint returns `428 Precondition Required` with the ToS text.

### Analytics (Owner Only)

```typescript
// GET /api/v1/instances/:instanceId/analytics
interface InstanceAnalyticsResponse {
  totalSessions: number;
  uniqueVisitors: number;
  avgSessionLengthSeconds: number;
  period: { from: string; to: string };
}
```

---

## UI/UX Design (Brief)

- **Instance Settings Panel**: A dropdown or toggle group for exposure mode. Changing to `public` reveals the public profile form.
- **Shared with Me**: A dedicated section on the user's dashboard listing all private instances they have access to, with online/offline indicators.
- **Public Discovery Page**: A searchable, filterable grid of public agent cards. Each card shows the public name, owner, category, and status.
- **Public Chat Page**: A clean, minimal chat interface. If the agent is offline, a banner replaces the input area with a "Notify me when back" button.
- **Owner Analytics**: A simple chart dashboard accessible from the instance settings.

---

## Migration Path

1. **Schema Migration**: Add `exposure`, `allowedUserIds`, `publicName`, `description`, `tags`, `category`, `publishedAt`, `featured`, and `monetization` columns to the `agent_instances` table.
2. **Default Values**: Existing instances default to `exposure = 'unexposed'`.
3. **Meilisearch Index**: Create a new `public_instances` index with searchable attributes `publicName`, `description`, and `tags`.
4. **Runtime Update**: Deploy a new runtime version that handles `exposure.update` control messages.
5. **Gradual Rollout**: Enable public exposure only for email-verified accounts via a feature flag.

---

## Reasoning

- **Three modes, not two**: A distinct `unexposed` mode simplifies the mental model. It makes it explicit that the instance is purely local and avoids ambiguity about whether a disconnected runtime is "private but offline" or truly unexposed.
- **Runtime owns the tunnel**: PekoHub signals exposure changes, but the runtime decides when to open or close the tunnel. This respects the user's control over their machine and network.
- **Meilisearch for discovery**: We already use Meilisearch for agent/team search. Reusing it for public instance discovery keeps the stack consistent and provides fast, typo-tolerant search out of the box.
- **Privacy-preserving analytics**: Storing only metadata aligns with our principle that PekoHub is a proxy, not a data processor. It also reduces liability and storage costs.
- **Monetization hooks without implementation**: Adding `monetization` to the schema now prevents a painful migration later, but leaving it unimplemented avoids premature complexity.

---

## Tradeoffs Accepted

- **Owner responsibility for sandboxing**: Public agents run on the owner's hardware. We trust owners to configure sandboxing correctly. PekoHub cannot enforce this without hosting the runtime itself, which is out of scope.
- **IP-based rate limiting for public access**: Less precise than user-based limiting, but necessary since public access is anonymous. We accept that NATed users may share rate-limit buckets.
- **Meilisearch eventual consistency**: There may be a brief delay (sub-second) between an exposure change and discovery index updates. This is acceptable for our use case.

---

## Alternatives Considered

### A. Two Exposure Modes (Private / Public)
Rejected. Collapsing "unexposed" into "private with no allowed users" is confusing. Users might think their instance is remotely accessible when it is not, or vice versa. A three-state model is clearer.

### B. PekoHub-Hosted Runtime for Public Agents
Rejected. Hosting agent execution would require massive infrastructure changes, break the local-first philosophy, and introduce security risks for PekoHub. The tunnel-based proxy model keeps execution on the owner's machine.

### C. Elasticsearch Instead of Meilisearch
Rejected. Meilisearch is already in use, lighter to operate, and provides sufficient search capabilities for this feature. Elasticsearch would be overkill.

### D. OAuth 2.0 / API Keys for Public Access
Rejected. Public access is intentionally anonymous. For future paid agents, we may introduce API keys, but that is out of scope for this ADR.

---

## Consequences

### Positive

- Users can easily share agents with friends, teams, or the public.
- Public discovery turns PekoHub into a marketplace/directory for agents, increasing platform value.
- The privacy-preserving design builds user trust.
- Monetization hooks future-proof the architecture.

### Negative

- Public exposure increases support burden (moderation, abuse reports).
- IP-based rate limiting may be circumvented or accidentally penalize legitimate users behind NAT.
- Offline public agents create a poor visitor experience; we mitigate this with clear UI and a notification feature.

---

## Out of Scope (Future Work)

- **Paid public agents and subscription billing**: Hooked in schema, not implemented.
- **Custom domains for public agents**: e.g., `agent.example.com` instead of `pekohub.org/agents/:owner/:agentName`.
- **Public agent embeddable widgets**: iframe snippet for third-party sites.
- **Advanced analytics**: Per-message latency, geographic visitor maps, retention funnels.
- **Runtime-enforced sandbox policies**: PekoHub cannot enforce this; future runtime versions may add stronger defaults.

---

## Success Criteria

- [ ] Owner can toggle an instance between `unexposed`, `private`, and `public` via UI and API.
- [ ] Private instances are visible only to the owner and explicitly allowed users.
- [ ] Public instances appear in Meilisearch-powered search within 5 seconds of publishing.
- [ ] Public instance pages load and render a chat interface when online, and an offline message when disconnected.
- [ ] Anonymous public chat requests are rate-limited by IP.
- [ ] Owners can view privacy-preserving analytics (sessions, visitors, avg duration).
- [ ] Email verification is required before an instance can be set to `public`.
- [ ] Reported public instances can be delisted by PekoHub moderators.

---

## References

- ADR-002: Remote Instance Management API
- ADR-035: Tunnel Protocol
- ADR-033: Ownership & Permission Model
- ADR-036: Remote Instance Management
- [Meilisearch Documentation](https://www.meilisearch.com/docs)
