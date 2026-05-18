# Phase 2 Success Criteria: Public Registry Beta

> **Version**: 2.2
> **Phase**: 2 Months
> **Predecessor**: Phase 1 (Runtime Engine v1.0 + CLI v1.0 + Agent Bundle Spec v1.0)
> **Objective**: Enable agent discovery and sharing at scale through a public registry. Extension ecosystem and team orchestration are deferred to Phase 3.
> **Companion Document**: See `Phase2_Roadmap.md` for the implementation roadmap, execution order, milestones, and architecture diagrams.

---

## 1. Overview

Phase 2 transitions the Agent Runtime from a **local developer tool** into a **distributed platform for agent publishing and discovery**. This phase builds upon the stable foundation of Phase 1 to address the critical market gap identified in the research:

| Deliverable | Market Gap Addressed | Research Source |
|-------------|---------------------|-----------------|
| **Public Registry Beta** | "Agent Registry/Hub ecosystem almost blank" — no Docker Hub for Agents exists | Dim05, Insight 2 |

**Phase 2 is considered successful only when all P0 registry criteria are met AND the platform demonstrates active community publishing and discovery.**

> **Design Principle**: Phase 2 does NOT add team orchestration, memory management, coordination patterns, or extension runtime features to the core runtime. These are **deferred to Phase 3**. The core runtime remains unchanged.

> **Note on Shared Services Fabric**: The Shared Services Fabric (shared browser pool, vector DB, memory tiers) was originally scoped for Phase 2 but has been **deferred to Phase 3 / Cloud Runtime**. Agents and teams continue to use MCP servers and built-in tools for browser, vector, and memory operations — exactly as they do in Phase 1.

> **Note on Extension Ecosystem**: Extension source references, remote installation, A2A built-in tools, team orchestrator extensions, and the `team` extension type are all **deferred to Phase 3**. The registry supports `.ext` artifacts as publishable/discoverable OCI packages, but the runtime does not yet install extensions from remote sources.

---

## 2. Assumptions from Phase 1

Phase 2 depends on the following Phase 1 outputs being production-stable:

| Dependency | Minimum Version | Status Gate |
|------------|----------------|-------------|
| Runtime Engine | v0.1.0+ | All P0 criteria met, 1,024 unit tests passing |
| CLI | v0.1.0+ | Core commands stable (`agent`, `team`, `ext`, `session`, `send`, `config`, `daemon`) |
| Agent Bundle Spec | v1.0 | OCI-compatible, `.agent`/`.team`/`.ext` formats with SHA-256 checksums |
| Registry Client | v0.1.0+ | Push/pull with bearer/basic auth, layer deduplication |
| Extension Framework | v0.1.0+ | 22 hook points, 6 extension types, dynamic registration |
| IPC Layer (ADR-021) | v0.1.0+ | UDP/Unix socket CLI↔daemon communication |
| A2A Event Bus | v0.1.0+ | In-memory bus with Direct, Task, TaskResult, Broadcast, Subscribe message types |

> **Note**: Base image inheritance was removed per ADR-027. The canonical workflow is `peko agent create` → `peko agent export`.

---

## Progress Tracker (Last Updated: 2026-05-16)

| Milestone | Status | Notes |
|-----------|--------|-------|
| **Milestone 1: Registry Foundation** | 🟢 Mostly Complete | OCI push/pull working, PostgreSQL + MinIO storage, Meilisearch search index. GC service + daily cron. All OCI routes tested (59 tests passing). Audit logging wired. Fork + delete bundle/version APIs implemented. |
| **Milestone 2: Auth, Search, Web UI** | 🟢 Mostly Complete | OAuth (GitHub/Google) + API key auth + cookie fallback. Auth state fully wired (useAuth hook, /me, /logout, /auth/callback). Web UI: homepage, search (with pagination), bundle detail (markdown README, fork/delete/deprecate UI), profile (API keys, user bundles), auth-aware Layout. Mobile responsive. |

### Recent Fixes & Additions (2026-05-15 / 2026-05-16)
- ✅ Fixed Meilisearch search returning empty `items` array — root cause was `page`/`hitsPerPage` conflicting with `offset`/`limit` in Meilisearch v1.9
- ✅ Fixed TypeScript build errors across backend (auth plugin, OAuth routes, OCI routes)
- ✅ Fixed Meilisearch document ID sanitization (`a-zA-Z0-9_-` only)
- ✅ Fixed pull stats increment to use `(namespace, name)` composite key instead of name-only lookup
- ✅ Auto-index bundles into Meilisearch on successful manifest push
- ✅ Integration tests for OCI routes (catalog, tags, blobs, manifests) — 59 test cases passing
- ✅ API key generation endpoint (POST /api/v1/auth/api-keys) with bcrypt hash verification
- ✅ Rate limiting via @fastify/rate-limit configured with env vars; stricter limits on auth endpoints
- ✅ Bundle deprecation API (POST /api/v1/bundles/{ns}/{name}/versions/{ver}/deprecate)
- ✅ Latest tag resolution for manifest GET (resolves to newest version by createdAt)
- ✅ **Audit logging service** (`src/services/audit.ts`) with fire-and-forget push/pull/delete/permission_change logging
- ✅ **Audit log integration** wired into manifest PUT, blob GET, deprecation, and delete handlers
- ✅ **Audit log query API** (`GET /api/v1/admin/audit?namespace=&action=&page=&perPage=`) for namespace owners
- ✅ **Scheduled garbage collection** via `Scheduler` service — runs daily with configurable retention/batch size
- ✅ **Bundle forking API** (`POST /api/v1/bundles/:namespace/:name/fork`) — copies metadata + versions, preserves provenance via `forkedFrom`
- ✅ **Delete bundle/version APIs** — `DELETE /api/v1/bundles/:namespace/:name` (cascade) + `DELETE /api/v1/bundles/:namespace/:name/versions/:version`, owner-only, audit logged
- ✅ **Cookie-based JWT auth fallback** — `fastify.authenticate` reads `pekohub_session` cookie when no Bearer header present
- ✅ **Auth `/me` endpoint** (`GET /api/v1/auth/me`) — returns user profile from JWT cookie or Bearer token
- ✅ **Auth `/logout` endpoint** (`POST /api/v1/auth/logout`) — clears session cookie
- ✅ **Frontend auth context** (`useAuth` hook) — queries `/me`, manages token in localStorage, provides logout
- ✅ **OAuth callback page** (`/auth/callback`) — stores token from query param, redirects to home; proper error handling with "Go Home" fallback
- ✅ **Auth-aware Layout** — user avatar, display name, Profile/Sign out dropdown; mobile hamburger menu with auth-aware drawer; `<Link>` for profile navigation
- ✅ **Auth-gated deprecation UI** — only namespace owners see deprecate/undeprecate buttons
- ✅ **Auth-gated delete UI** — fork visible to all authenticated users; delete bundle/version buttons visible only to owner
- ✅ **Profile page** (`/profile`) — user info, API key generation/revocation list, user's bundles
- ✅ **Mobile responsiveness pass** — all pages (header, hero, search, bundle detail, profile) stack vertically at <640px
- ✅ **Search pagination** — page state + Previous/Next controls, resets on new query
- ✅ **Markdown rendering** — bundle README rendered via react-markdown + remark-gfm (tables, code blocks, blockquotes, GFM)
- ✅ **`peko search`** — REG-027: `peko search <query>` with pagination and type filtering; also `peko search info <bundle>` for detailed metadata
- ✅ **`peko auth login/logout/status --registry`** — registry token management via `CredentialsService` (API key auth)
- ✅ **`peko agent push` → PekoHub** — REG-028: registry token injected into `RegistrySource`, `resolve_auth` prioritizes source token
- ✅ **`peko agent pull` → PekoHub** — REG-029: same token injection pattern as push

---

## 3. Public Registry Beta v1.0

### 3.1 Purpose

The Public Registry is the discovery and distribution layer for Agent Bundles. It addresses the "almost blank" state of the agent registry ecosystem — currently, only Microsoft Copilot Studio (70+ agents) and Salesforce AgentExchange offer curated collections, but neither is cross-platform or open. The Public Registry must become the "Docker Hub for Agents."

### 3.2 P0 — Must Have

#### 3.2.1 Registry Core Infrastructure
- [x] **REG-001**: Registry MUST implement the OCI Distribution Spec v1.1 for push/pull/tag operations, ensuring any OCI-compliant client (docker, oras, CLI) can interact with it
- [~] **REG-002**: Registry MUST support manifest listing for bundle discovery, including support for tag lists, digest resolution, and multi-arch/index manifests — *tag list implemented (GET /v2/{namespace}/{name}/tags/list), multi-arch/index not tested*
- [x] **REG-003**: Registry MUST persist bundle metadata (manifest.json content) in a queryable database (PostgreSQL or equivalent) enabling search and filtering
- [x] **REG-004**: Registry MUST implement content-addressable storage — all blob uploads are de-duplicated via digest, and layer re-use is automatic across bundles
- [x] **REG-005**: Registry MUST support garbage collection of unreferenced blobs with configurable retention policies — ✅ `GarbageCollector` class + `Scheduler` daily cron job; admin manual trigger also available
- [~] **REG-006**: Registry MUST expose a REST API (OpenAPI 3.1 documented) with the following endpoints:
  - `GET /v2/_catalog` — List all bundle namespaces — ✅ implemented
  - `GET /v2/{namespace}/bundles/tags/list` — List tags for a bundle — ✅ implemented
  - `GET /v2/{namespace}/bundles/manifests/{reference}` — Pull a manifest — ✅ implemented
  - `PUT /v2/{namespace}/bundles/manifests/{reference}` — Push a manifest — ✅ implemented
  - `GET /api/v1/search?q={query}` — Full-text search across bundles — ✅ implemented
  - `GET /api/v1/bundles/{namespace}/{name}` — Bundle metadata and README — ✅ implemented
  - `GET /api/v1/bundles/{namespace}/{name}/versions` — Version history — ✅ implemented
- [x] **REG-007**: Registry MUST authenticate users via OAuth 2.0 (GitHub, Google, or equivalent) and support organization/team namespaces — ✅ OAuth + API key + cookie fallback; `GET /api/v1/auth/me` and `POST /api/v1/auth/logout` implemented
- [x] **REG-008**: Registry MUST enforce namespace ownership — only authenticated owners of a namespace can push or delete bundles within it — ✅ Enforced in deprecate and delete endpoints; dev-mode bypass available

#### 3.2.2 Bundle Discovery & Search
- [x] **REG-009**: Registry MUST index the following searchable fields from bundle manifests: name, description, author, tags/keywords, required MCP servers, supported model providers, skill definitions, license, and extension type
- [x] **REG-010**: Registry MUST provide full-text search with relevance ranking across all indexed fields, supporting phrase matching and boolean operators (`AND`, `OR`, `NOT`)
- [~] **REG-011**: Registry MUST support faceted search — users can filter by: model provider (OpenAI/Anthropic/local), MCP server dependencies, category (research/support/development/content), license, bundle type (agent/team/extension), and extension type (skill/mcp/gateway/universal/general/team) — *filter fields configured in Meilisearch, API filter params implemented, tests passing*
- [~] **REG-012**: Registry MUST auto-generate a public HTML page for every published bundle containing: metadata, README, version history, dependency tree, installation command, and usage statistics (pull count, star count) — *Bundle detail page implemented at `/bundles/:namespace/:name`: metadata, GFM README (react-markdown), version history, daily/weekly/monthly/all-time pull stats, install command. Dependency tree (MCP servers, required tools) not yet rendered.*
- [~] **REG-013**: Registry MUST expose a public Web UI (`https://pekohub.org`) with: homepage featuring trending bundles, category browsing, search with autocomplete, bundle detail pages, and user profile pages — ✅ Homepage, search, bundle detail, and profile pages scaffolded. Auth state wired. Deploy pipeline not started.
- [~] **REG-014**: Web UI MUST be responsive and functional on mobile devices (viewport ≥ 375px) — ✅ Mobile pass completed on all pages: header (hamburger menu), hero, search, bundle detail, profile. Flexbox + grid breakpoints verified.

#### 3.2.3 Bundle Management
- [~] **REG-015**: Registry MUST support semantic versioning (MAJOR.MINOR.PATCH) with `latest` tag resolution and version constraint syntax (`>=1.0.0`, `^1.2.0`, `~1.2.3`) — *semver validation + latest tag resolution implemented (tested); constraint syntax parsing not started*
- [x] **REG-016**: Registry MUST maintain version history with immutable manifests — once published, a manifest digest can never be modified (following OCI immutability guarantees)
- [~] **REG-017**: Registry MUST support bundle deprecation — owners can mark versions as deprecated with a redirect message to a replacement bundle — *API endpoint + auth-gated UI implemented (deprecate button on bundle detail page, owner only)*
- [~] **REG-018**: Registry MUST provide download/pull statistics (daily, weekly, monthly, all-time) per bundle and per version — *pull stats table exists, blob GET increments tracked, aggregation queries implemented in bundle detail API and displayed on bundle detail page*
- [x] **REG-019**: Registry MUST support bundle forking — any authenticated user can fork a public bundle to their own namespace, preserving provenance metadata — ✅ `POST /api/v1/bundles/:namespace/:name/fork` implemented with `forkedFrom` tracking

#### 3.2.4 Security & Trust
- [ ] **REG-022**: Registry MUST implement vulnerability scanning for bundle layers — report known CVEs in bundled tool binaries or Python/Node.js dependencies — *not started*
- [~] **REG-023**: Registry MUST enforce rate limits: anonymous users 100 pulls/hour, authenticated users 1,000 pulls/hour, with configurable limits per namespace — *@fastify/rate-limit configured with RATE_LIMIT_MAX/WINDOW_MS env vars; auth endpoints have custom in-memory 10/min limit*
- [x] **REG-024**: Registry MUST provide an audit log of all push, pull, delete, and permission-change events per namespace, accessible to namespace owners — ✅ `AuditService` + `GET /api/v1/admin/audit` endpoint; wired into manifest PUT, blob GET, deprecation

#### 3.2.5 CLI Integration
- [x] **REG-027**: CLI MUST implement `peko search <query>` command that queries the Registry search API and displays results with metadata in a terminal-friendly table — ✅ `src/commands/search.rs` — `peko search <query>` with `--page`, `--per-page`, `--type` filters; also includes `peko search info <bundle>` subcommand for detailed bundle metadata
- [x] **REG-028**: CLI `peko agent push` MUST integrate with the Public Registry as the default endpoint, requiring only `peko auth login` for authentication — ✅ `handle_agent_push` reads registry token from `CredentialsService`, injects into `RegistrySource.token`; `resolve_auth` in `client.rs` prioritizes source token over env-based auth
- [x] **REG-029**: CLI `peko agent pull` MUST resolve bundle references from the Public Registry (e.g. `peko agent pull pekohub.org/user/researcher:v1.0`) — ✅ `handle_agent_pull` same pattern as push; registry token wired via `CredentialsService`

> **CLI Naming Note**: The CLI uses `peko` as the binary name (not `agent`). Commands are `peko agent push`, `peko agent pull`, `peko search`, etc. See `Phase2_Roadmap.md` §3.3 for the full CLI command reference.

### 3.3 P1 — Should Have

- [ ] **REG-030**: Registry SHOULD support "Verified Publisher" badges for organizations that complete identity verification (domain ownership, public profile)
- [ ] **REG-031**: Registry SHOULD implement a review/rating system (1–5 stars + text review) for published bundles
- [ ] **REG-032**: Registry SHOULD support "Collections" — curated groups of bundles with a shared theme or use case (e.g. "Customer Support Team", "Research Toolkit")
- [ ] **REG-033**: Registry SHOULD provide an embeddable badge (`https://pekohub.org/badges/{namespace}/{name}/downloads`) for README files
- [ ] **REG-034**: Registry SHOULD support webhook notifications — notify external systems on push, pull, or security scan events
- [ ] **REG-035**: Registry SHOULD implement a public API rate limit increase program for open-source projects and educational institutions

### 3.4 P2 — Nice to Have

- [ ] **REG-035**: Registry COULD support "Agent Teams" as first-class publishable entities — a `team.toml` + multiple bundle references published as a single artifact
- [ ] **REG-036**: Registry COULD provide analytics dashboards for publishers (geographic distribution of pulls, provider breakdown, dependency graphs)
- [ ] **REG-037**: Registry COULD implement an "Agent of the Week" editorial program featuring community-contributed bundles

---

## 4. Extension Artifacts in the Registry (Passive Support)

### 4.1 Purpose

Phase 2's registry treats `.ext` packages as **first-class OCI artifacts** for publishing and discovery. This enables the community to publish extensions to the registry even though the runtime does not yet support remote installation.

### 4.2 P0 — Must Have

- [ ] **EXT-REG-001**: Registry MUST accept `.ext` packages via standard OCI push/pull operations (same as `.agent` and `.team`)
- [ ] **EXT-REG-002**: Registry MUST index extension metadata including: extension type, hook points declared, example configuration, and compatibility information
- [ ] **EXT-REG-003**: Registry Web UI MUST display extension detail pages with metadata, README, version history, and manual download instructions
- [ ] **EXT-REG-004**: Registry search MUST include extensions in results and support filtering by extension type

### 4.3 What Is Deferred to Phase 3

All extension runtime features are deferred to Phase 3. See "Phase 3 Preview" below for the complete list.

---

## 5. Performance & Reliability

### 5.1 P0 — Must Have

- [ ] **PERF-001**: Registry MUST handle 100 concurrent push/pull operations with p95 latency < 2 seconds for manifests and < 10 seconds for 100MB bundles
- [ ] **PERF-002**: Registry uptime MUST be ≥ 99.5% (measured monthly)

### 5.2 P1 — Should Have

- [ ] **PERF-003**: Registry SHOULD scale horizontally to 1,000 concurrent operations via load balancing

---

## 6. Security

### 6.1 P0 — Must Have

- [ ] **SEC-001**: Registry MUST enforce HTTPS-only communication with TLS 1.3
- [ ] **SEC-002**: Registry access tokens MUST expire within 24 hours and support revocation
- [ ] **SEC-003**: All audit logs MUST be append-only with tamper-evident hashing (Merkle tree or equivalent)
- [ ] **SEC-004**: Bundle vulnerability scans MUST complete within 5 minutes of push and block pull of critical-severity bundles until acknowledged

### 6.2 P1 — Should Have

- [ ] **SEC-005**: Registry SHOULD support private namespaces with granular collaborator permissions (read, write, admin)

---

## 7. Developer Experience

### 7.1 P0 — Must Have

- [ ] **DX-001**: Public Registry Web UI MUST be publicly accessible at `https://pekohub.org` with no authentication required for browsing and search
- [ ] **DX-002**: At least 50 community-contributed bundles MUST be published on the Public Registry by the end of Phase 2
- [ ] **DX-003**: Complete documentation for registry usage — how to publish, search, and install bundles from the registry

### 7.2 P1 — Should Have

- [ ] **DX-004**: A "Getting Started" wizard in the CLI that guides new users through registry login and agent discovery
- [ ] **DX-005**: Video walkthroughs (2+ videos) of Registry usage

---

## 8. Success Metrics & KPIs

Phase 2 is considered **successful** when all P0 criteria are met AND:

| Metric | Target | Measurement Method |
|--------|--------|-------------------|
| **Registry: Published Bundles** | ≥ 50 (community) + ≥ 10 (official) | Registry API count |
| **Registry: Monthly Active Users** | ≥ 500 unique users | OAuth login events |
| **Registry: Total Pulls** | ≥ 10,000 cumulative | Registry analytics |
| **Test Coverage** | ≥ 75% | Code coverage report |
| **Documentation Pages** | ≥ 20 pages | docs site count |
| **GitHub Stars** | ≥ 5,000 | GitHub API |
| **Active Contributors** | ≥ 30 unique | GitHub commit log |
| **Response Time (p95)** | Registry <2s | Load testing |

---

## 9. Phase 3 Preview (Deferred Workstreams)

The following workstreams were originally scoped for Phase 2 but have been **deferred to Phase 3**. They are preserved here for planning purposes.

### 9.1 Extension Ecosystem

#### Extension Source References
- **EXT-001** through **EXT-008**: `github:`, `https:`, `mcp+https:` source resolution; `peko ext install`, `peko ext update`, `peko ext list --outdated`

#### Extension Registry Integration
- **EXT-009** through **EXT-012**: `peko ext publish`, `peko ext install <registry-ref>`, extension metadata indexing, extension detail pages with hook usage

#### A2A Built-in Tools
- **EXT-013** through **EXT-015**: `a2a_send`, `a2a_broadcast`, `a2a_receive` built-in tools integrating with `EventEmit`/`EventSubscribe` hooks

#### P1/P2 Extensions
- **EXT-016** through **EXT-022**: `a2a_subscribe`/`a2a_unsubscribe`, version constraints, `peko ext init`, extension dependencies, `team` extension type adapter, hot-reloading, marketplace API

### 9.2 Team Orchestration via Extensions

- **TEAM-001** through **TEAM-010**: Team orchestrator extensions (supervisor pattern), `agent.toml` configuration, declarative team composition, 3-agent demo
- **TEAM-011** through **TEAM-015**: Pipeline and mesh extensions, OpenTelemetry tracing, dynamic scaling, human-in-the-loop

### 9.3 Deferred Performance & Security

- **PERF-004** through **PERF-010**: Extension hook invocation, A2A message delivery, 3-agent team E2E, extension installation speed, extension crash handling, 20-agent concurrency
- **SEC-005** through **SEC-008**: Extension SHA-256 verification, MCP env stripping, private namespaces, filesystem restrictions

---

## 10. Out of Scope (Explicitly Deferred)

| Feature | Rationale | Target Phase |
|---------|-----------|-------------|
| **Extension source references** | Needs dedicated runtime work; registry is higher priority | Phase 3 |
| **Remote extension installation** | Depends on source references | Phase 3 |
| **A2A built-in tools** | Needs A2A event bus stabilization | Phase 3 |
| **Team orchestration as extensions** | Large workstream; deserves its own phase | Phase 3 |
| **`team` extension type adapter** | Depends on team orchestration | Phase 3 |
| **Shared Services Fabric** | Premature for local single-user tool. Agents already share MCP tools via single process. Relevant for cloud/multi-tenant runtime. | Phase 3 |
| **Enterprise Governance Layer** | RBAC, SSO, audit dashboards — requires enterprise customers and Phase 3 maturity | Phase 3 |
| **Cloud Runtime Service (SaaS)** | Managed multi-tenant cloud offering — requires operational infrastructure and cost modeling | Phase 3 |
| **A2A Protocol v1.0** | Agent-to-Agent protocol is still stabilizing (v1.0 expected early 2026) — our event bus + A2A tools are sufficient | Phase 3 |
| **Advanced Security (microVM isolation)** | gVisor/Firecracker — needs Fabric/cloud runtime first | Phase 3 |
| **Registry Monetization** | Verified Publisher fees, Private Registry SaaS — needs market validation first | Phase 3 |
| **Federated Registries** | Cross-registry search and mirroring — single registry must mature first | Phase 3+ |
| **Agent Commerce / Payments** | Visa/Mastercard integration — market not mature, protocol not finalized | Phase 3+ |
| **New hook points beyond the existing 22** | Existing hooks cover all known use cases for Phase 2; add only if proven necessary | Future |
| **Team orchestration in core runtime** | Violates extension philosophy; all coordination patterns are extension concerns | N/A |

---

## 11. Architecture Overview

### 11.1 Phase 2 System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Public Registry                            │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │
│  │  Search  │  │  Bundle  │  │   Auth   │  │  Audit   │    │
│  │  Index   │  │  Store   │  │  (OAuth) │  │   Log    │    │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘    │
│  ┌──────────────────────────────────────────────────────┐   │
│  │          Web UI (pekohub.org)                        │   │
│  └──────────────────────────────────────────────────────┘   │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTPS / OCI
┌──────────────────────────┴──────────────────────────────────┐
│                    CLI (peko)                                 │
│  push │ pull │ search │ auth login │ agent install           │
└─────────────────────────────────────────────────────────────┘
```

> **Note**: The runtime engine and extension framework remain unchanged from Phase 1. No new hook points, A2A tools, or extension runtime features are added in Phase 2.

---

## 12. Definition of Done

Phase 2 is **officially complete** when:

1. ✅ All P0 success criteria (REG-001 through REG-027, EXT-REG-001 through EXT-REG-004, SEC-001 through SEC-004, PERF-001 through PERF-002, DX-001 through DX-003) are implemented, tested, and documented
2. ✅ All quantitative KPIs meet or exceed their targets
3. ✅ Public Registry is live at `https://pekohub.org` with ≥ 50 community bundles
4. ✅ Registry supports `.agent`, `.team`, and `.ext` as publishable OCI artifact types
5. ✅ At least 3 external teams (outside the core dev team) have successfully published bundles on the platform
6. ✅ Phase 2 retrospective document is published, capturing lessons learned and Phase 3 priorities

---

*End of Phase 2 Success Criteria Document v2.2*