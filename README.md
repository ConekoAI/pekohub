# PekoHub

Public registry, relay, and discovery hub for [peko-runtime](https://github.com/ConekoAI/peko-runtime) pekos.

PekoHub is three things in one server:

1. **OCI Distribution Spec v1.1 registry** for peko templates and extensions (multi-segment repo paths like `peko/principals/<name>`; pushes are zero-layer template manifests — see ADR-005).
2. **Tunnel relay** that proxies chat traffic from public callers to runtime-owned pekos.
3. **Discovery + share directory** so users can find and chat with exposed pekos — anonymously in the browser, or via `peko-desktop` after a share link.

The hub is intentionally a thin router. Per-peer access decisions live in the runtime's `PrincipalConfig.permissions` (the authoritative inbound ACL). The hub only mirrors `exposure` / `status`, and forwards identity as short-lived EdDSA bridge tokens (ADR-057/058).

> **Terminology (runtime ADR-059 / hub ADR-005):** "peko" is the user-facing term; wire and machine names keep the `principal` vocabulary (`principal_did`, `/v1/principals/*`, `bundleType: "principal"`).

## Architecture

```
pekohub/
├── backend/          # Fastify API — OCI registry + tunnel relay + public chat
├── frontend/         # React SPA — Vite + Tailwind + TanStack Router
├── packages/shared/  # Zod schemas (Subject, TargetSpec, PublicProfile)
└── docker-compose.yml
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js 22, Fastify, Drizzle ORM, PostgreSQL |
| Frontend | React 18, Vite, Tailwind CSS, TanStack Router/Query |
| Search | Meilisearch |
| Storage | S3-compatible (MinIO locally, R2/S3 in prod) |
| Auth | OAuth 2.0 (GitHub, Google) via Arctic |
| Monorepo | pnpm workspaces + Turborepo |

## Quick Start

### Prerequisites

- Node.js 22+
- pnpm 9+
- Docker + Docker Compose

### 1. Install dependencies

```bash
cd pekohub
pnpm install
```

### 2. Start infrastructure

```bash
docker-compose up -d
```

This starts PostgreSQL, MinIO (S3), and Meilisearch.

### 3. Configure environment

```bash
cp backend/.env.example backend/.env
# Edit backend/.env with your OAuth credentials (optional for local dev)
```

### 4. Run database migrations

```bash
cd backend
pnpm db:migrate
```

(The migration chain was squashed to a fresh baseline in ADR-005 — `db:migrate` works from an empty database. For the one-time step on a pre-baseline production DB, see `DEPLOYMENT.md`.)

### 5. Start dev servers

```bash
# Terminal 1 — backend
cd backend
pnpm dev

# Terminal 2 — frontend
cd frontend
pnpm dev
```

- Backend: http://localhost:3000
- Frontend: http://localhost:5173
- API docs: http://localhost:3000/docs

## API Overview

All custom endpoints are mounted under `/v1`. OCI endpoints are at `/v2/...`. The runtime CLI's hard-coded `/api/v1` prefix (search, bundle detail, OAuth) is served as an alias of the same handlers.

### OCI Distribution Spec v1.1

`{repo}` is a multi-segment repository path (e.g. `peko/principals/my-peko` or `alice/my-extension`). Write endpoints require a JWT or `pkr_` API key; the first push claims the repo for its publisher (`bundles.publisher_id`).

| Endpoint | Description |
|----------|-------------|
| `GET /v2/_catalog` | List all bundle repos |
| `GET /v2/{repo}/tags/list` | List tags |
| `GET /v2/{repo}/manifests/{ref}` | Pull manifest |
| `PUT /v2/{repo}/manifests/{ref}` | Push manifest (publisher-only on existing repos) |
| `GET /v2/{repo}/blobs/{digest}` | Pull blob |
| `POST /v2/{repo}/blobs/uploads/` | Initiate blob upload (auth required) |
| `PUT /v2/{repo}/blobs/uploads/{uuid}` | Complete blob upload (auth required) |

### Tunnel relay

| Endpoint | Description |
|----------|-------------|
| `GET /v1/tunnel` (WebSocket) | Outbound tunnel from a peko-runtime instance. Two-phase Ed25519 challenge-response handshake. 30s heartbeat / 90s timeout. Requires the runtime's DID to already be in the `runtimes` allowlist (see `POST /v1/runtimes/register`). |

### Runtime management

| Endpoint | Description |
|----------|-------------|
| `POST /v1/runtimes/register-challenge` | Issue a single-use registration nonce (~60s TTL) for the PoP flow below (ADR-058 D4). |
| `POST /v1/runtimes/register` | Upsert a runtime DID into the relay allowlist. Called by `peko tunnel setup`. Requires `pop: {nonce, jws}` — a compact EdDSA JWS over canonical JSON `{"nonce","runtimeDid","owner","iat","exp"}` signed with the claimed DID's key (ADR-058 D4). |
| `GET /v1/runtimes` | List runtimes owned by the caller. |
| `GET /v1/runtimes/:did` | Get a runtime by DID (owner-only). |

### Peko exposure & chat

A "peko" is a runtime-owned AI actor (`did:key:...`; wire field `principal_did`). Owners expose their pekos via the runtime (`exposure` in `principal.toml`) or this API. The hub mirrors the `exposure` field and proxies chat traffic.

`exposure` is one of:
- `unexposed` — not visible to anyone; not chat-able.
- `private` — chat-able only by subjects explicitly listed in `PrincipalConfig.permissions` on the runtime.
- `public` — chat-able by anyone; indexed in `/v1/discovery/*`.
- `unlisted` — chat-able by anyone with the URL; **not** indexed in discovery. The default for share-link use cases.

Per runtime ADR-056 D7, at most one instance per `principal_did` may be `public` or `unlisted` at a time — conflicting announces/exposure changes are rejected (409).

| Endpoint | Description |
|----------|-------------|
| `GET /v1/public/pekos/:owner/:pekoName` | Public profile for any `public` or `unlisted` peko. |
| `POST /v1/public/pekos/:owner/:pekoName/chat` | Anonymous chat via SSE. A signed visitor cookie (HMAC, 365-day HttpOnly/SameSite=Lax) identifies the caller to the runtime. 20 req/60s/IP rate limit; per-instance `dailyQuota`/`weeklyQuota`; optional ToS gate (returns 428). |
| `GET /v1/instances/public` | List public pekos (paginated). |
| `GET /v1/instances/public/search` | Full-text search over public pekos. |
| `GET /v1/discovery/search` | Faceted search: `q`, `category`, `sort` (`relevance` / `recent` / `popular`). Returns only `exposure = public`. |
| `GET /v1/discovery/feed/:feed` | Curated feed (`trending` / `new` / `featured`). |

The SPA's canonical share URL is `/peko/:owner/:name` (`/p/:owner/:name` redirects).

### Authenticated instance management

| Endpoint | Description |
|----------|-------------|
| `GET /v1/instances` | List instances owned by the caller (any exposure). |
| `GET /v1/me/accessible-pekos` | Same, with rich per-instance metadata. |
| `POST /v1/instances` | Create a new instance. |
| `GET /v1/instances/:id` | Read instance metadata. |
| `PATCH /v1/instances/:id` | Update name / description / tags / category / `tosRequired` / `tosText`. |
| `PATCH /v1/instances/:id/exposure` | Body `{ exposure }`. Pushes `exposure_update` down the tunnel; runtime persists to `principal.toml`. 409 on an ADR-056 D7 conflict (another instance with the same DID already public/unlisted). |
| `PATCH /v1/instances/:id/status` | Body `{ status }` (`online` / `offline` / `busy` / `error`). Pushes `status_update` down the tunnel. |
| `DELETE /v1/instances/:id` | Revoke exposure and delete the row. |
| `POST /v1/instances/:id/chat` | Authenticated chat (SSE) for owners and permitted callers. |

### Principal directory (cross-runtime channel addressing)

| Endpoint | Description |
|----------|-------------|
| `GET /v1/principals/by-did/:did` | Resolve a principal by DID. Requires auth. |
| `GET /v1/principals/by-handle/:owner/:name` | Resolve a principal by handle. Requires auth. |

Both endpoints return `PrincipalTargetResolution { status: "hit" | "miss" | "denied", target?: ... }`. Used by the runtime's directory client to dial peers (channel-native `ChannelSend` flows). These are machine-facing wire paths and keep the `principal` vocabulary per ADR-059.

### OAuth & API keys

| Endpoint | Description |
|----------|-------------|
| `GET /v1/auth/:provider/authorize` | OAuth login (`github` or `google`). |
| `GET /v1/auth/:provider/callback` | OAuth callback. |
| `POST /v1/auth/api-keys` | Create an API key (returns plaintext key once). |
| `GET /v1/auth/api-keys` | List API keys owned by the caller. |
| `DELETE /v1/auth/api-keys/:id` | Revoke an API key. |

### Health & metrics

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Liveness probe. |
| `GET /metrics` | In-process counter snapshot (intentionally unauthenticated). |

## Data model

The `instances` table is the only one that holds peko state. Its key fields:

| Column | Type | Notes |
|--------|------|-------|
| `principal_did` | text, indexed (not unique) | `did:key:...` of the peko. Multiple rows per DID are allowed (transported copies); ADR-056 D7 caps public/unlisted exposure at one per DID. |
| `principal_did_verified` | boolean | Set when the announce carried a valid `principalPop` JWS (ADR-058 D4). |
| `owner_subject` | jsonb | `{ kind: "user", id: <uuid> }` of the owner. |
| `exposure` | varchar(20) | `unexposed` / `private` / `public` / `unlisted`. |
| `status` | varchar(20) | `online` / `offline` / `busy` / `error`. Heartbeat-driven; 90s timeout. |
| `last_seen_at` | timestamptz | Updated on every heartbeat. Sweep job marks stale rows offline. |

(`transport_preference` / `direct_endpoint` were dropped — tunnel is the only transport post-ADR-057.)

There is no `allowed_principals` table — it was deliberately removed. The runtime's `PrincipalConfig.permissions: Vec<PermissionGrant>` is the authoritative inbound ACL.

## Deployment

### Frontend → Cloudflare Pages / S3 + CloudFront

The frontend is a static SPA. Build and deploy:

```bash
cd frontend
pnpm build
# Upload dist/ to your CDN
```

### Backend → AWS App Runner / ECS / Fly.io

```bash
cd backend
docker build -t pekohub-backend -f Dockerfile ..
```

Environment variables required in production:
- `DATABASE_URL`
- `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`
- `MEILISEARCH_URL`, `MEILISEARCH_API_KEY`
- `JWT_SECRET`
- `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`

## Scripts

```bash
pnpm dev      # Start all dev servers (via turbo)
pnpm build    # Build all packages
pnpm lint     # Lint all packages
pnpm test     # Run all tests
```

## License

MIT