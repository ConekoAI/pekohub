# Phase 2 Roadmap: Public Registry Beta

> **Version**: 2.2
> **Phase**: 2 Months (following Phase 1 completion 2026-05-14)
> **Objective**: Enable principal discovery and sharing at scale through a public registry. Extension ecosystem and team orchestration are deferred to Phase 3.

See `Phase2_Success_Criteria.md` for the complete, detailed success criteria. This document is the **implementation roadmap** — it identifies the workstreams, their dependencies, and the suggested execution order.

> **⚠️ Historical note (post-#21 / ADR-041 / ADR-042):** This roadmap predates the
> "principal-as-container" clean break. References to `.team` bundles, the `team`
> extension type, and "team orchestration" describe deferred/removed concepts: agents
> and teams are now unified as **principals**, and the `Team` subject variant was
> removed runtime-wide (see
> [ADR-042](../architecture/adr/ADR-042-principal-as-container-v2.md)). Team
> orchestration remains deferred. Retained as the original Phase 2 planning record.

---

## 1. Overview

Phase 2 has one workstream that builds on the Phase 1 runtime:

| Workstream | What It Does | Depends On |
|------------|-------------|------------|
| **Public Registry Beta** | Hosted registry + web UI for publishing and discovering principals and extensions | Phase 1 packaging (`src/portable/`), registry client (`src/registry/`) |

The success criteria are defined in the companion document. This roadmap focuses on **execution order** and **integration points**.

> **Design Principle**: Phase 2 does NOT add team orchestration, memory management, coordination patterns, or extension runtime features. These are **deferred to Phase 3**. The core runtime remains unchanged. See §7 for the full rationale.

> **Note on Shared Services Fabric**: The Shared Services Fabric (shared browser pool, vector DB, memory tiers) was originally scoped for Phase 2 but has been **deferred to Phase 3 / Cloud Runtime**. Principals continue to use MCP servers and built-in tools for browser, vector, and memory operations — exactly as they do in Phase 1.

> **Note on Extension Ecosystem**: Extension source references, remote installation, and A2A built-in tools are all **deferred to Phase 3**. Phase 2's registry supports `.ext` artifacts as publishable/discoverable packages (same as `.principal`), but the runtime does not yet install extensions from remote sources.

---

## 2. Execution Order

We recommend building Phase 2 in two milestones, each delivering user-visible value:

### Milestone 1: Registry Foundation (Weeks 1–4)
**Goal:** A deployable registry server that can accept pushes and serve pulls.

- Registry server implementing OCI Distribution Spec v1.1
- Content-addressable blob storage (filesystem → S3)
- PostgreSQL metadata store for search indexing
- Tag → digest resolution
- SHA-256 verification on upload
- Garbage collection of unreferenced blobs

**User outcome:** `peko principal push` and `peko principal pull` work against the public registry.

**Success criteria:** REG-001 through REG-006

### Milestone 2: Auth, Search, and Web UI (Weeks 5–8)
**Goal:** Users can discover and browse packages without using the CLI.

- OAuth 2.0 login (GitHub, Google)
- API key generation for CLI auth
- Namespace ownership enforcement
- Full-text search with faceted filtering
- Public web UI at `https://pekohub.org`
- Bundle detail pages (README, version history, install command)

**User outcome:** A developer can find a principal or extension on the web, copy the install command, and run it.

**Success criteria:** REG-007 through REG-027

---

## 3. Public Registry Beta

### 3.1 Architecture

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
│  push │ pull │ search │ auth login │ principal install       │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| OCI Distribution Spec v1.1 | Existing client (`src/registry/`) already speaks this; ecosystem compatibility |
| PostgreSQL for metadata | Queryable, transactional, supports full-text search (pg_trgm) |
| Filesystem blob store initially | Simplest to deploy; migrate to S3 when scale demands |
| OAuth 2.0 only (no email/password initially) | Reduces security surface; GitHub/Google cover 99% of developers |
| Namespace = GitHub username initially | Simple, no custom namespace disputes |
| Registry server in separate repo (`pekobot/registry` or `pekohub`) | Independent deployable service with its own release cycle and ops concerns |

### 3.3 CLI Commands

```bash
# Authentication
peko auth login                    # OAuth browser flow
peko auth logout                   # Clear credentials
peko auth status                   # Show logged-in user

# Discovery
peko search "github assistant"     # Search registry
peko principal info user/agent:1.0     # Show bundle metadata

# Publishing (aliases for push/pull)
peko principal publish my-agent        # Push to public registry
peko principal install user/agent:1.0  # Pull + import in one step
```

> **Note on Extensions**: `peko ext publish` and `peko ext install <registry-ref>` are deferred to Phase 3. The registry accepts `.ext` packages (they are OCI artifacts like any other), but the CLI does not yet resolve or install them from remote sources.

---

## 4. Extension Artifacts in the Registry (Passive Support)

Phase 2's registry treats `.ext` packages as **first-class OCI artifacts** for publishing and discovery, but the runtime does not yet install them from remote sources.

### 4.1 What Works in Phase 2

- `.ext` packages can be pushed to and pulled from the registry via standard OCI operations
- Registry indexes extension metadata (extension type, hook points declared, compatibility)
- Web UI displays extension detail pages with installation commands (for manual/local install)
- Search and faceted filtering include extensions alongside principals

### 4.2 What Is Deferred to Phase 3

| Feature | Phase 3 Workstream |
|---------|-------------------|
| `peko ext install github:owner/repo` | Extension Source References |
| `peko ext install https://...` | Extension Source References |
| `peko ext install pekohub.org/...` | Extension Registry Integration |
| `peko ext update <id>` | Extension Source References |
| `peko ext list --outdated` | Extension Source References |
| A2A built-in tools (`a2a_send`, `a2a_broadcast`, `a2a_receive`) | A2A Tooling |

---

## 5. Cross-Cutting Concerns

### 5.1 Security

| Concern | Approach | Success Criteria |
|---------|----------|-----------------|
| Registry HTTPS | TLS 1.3 only | SEC-001 |
| Token expiry | 15-min access JWT + 30-day refresh token with rotation + revocation | SEC-002 (see ADR-001) |
| Audit logs | Append-only with tamper-evident hashing | SEC-003 |
| Vulnerability scans | Scan on push, block critical | SEC-004 |

### 5.2 Performance Targets

| Metric | Target | Verification |
|--------|--------|-------------|
| Registry concurrent ops | 100 push/pull, p95 < 2s | Load test |
| Registry uptime | ≥ 99.5% monthly | Monitoring |

### 5.3 Developer Experience

| Deliverable | Target | Owner |
|-------------|--------|-------|
| Public registry live | `pekohub.org` | Registry team |
| Community bundles | ≥ 50 published | Community |
| Tutorial series | 2+ tutorials: "Publishing to registry", "Discovering principals on PekoHub" | Docs |
| CLI getting-started wizard | Interactive `peko init` for registry login + principal discovery | CLI |

---

## 6. Success Metrics & KPIs

Phase 2 is successful when all P0 criteria are met AND:

| Metric | Target | Measurement |
|--------|--------|-------------|
| Published bundles | ≥ 50 community + 10 official | Registry API |
| Monthly active users | ≥ 500 | OAuth events |
| Total pulls | ≥ 10,000 cumulative | Analytics |
| Test coverage | ≥ 75% | Coverage report |
| Documentation pages | ≥ 20 | docs site |
| GitHub stars | ≥ 5,000 | GitHub API |
| Active contributors | ≥ 30 | Commit log |

---

## 7. Out of Scope (Deferred to Phase 3)

| Feature | Rationale |
|---------|-----------|
| **Extension source references** (`github:`, `https:`, `mcp+https:`) | Needs dedicated runtime work; registry is higher priority |
| **Remote extension installation** (`peko ext install <remote>`) | Depends on source references; defer together |
| **A2A built-in tools** (`a2a_send`, `a2a_broadcast`, `a2a_receive`) | Needs A2A event bus stabilization; not required for registry |
| **Shared Services Fabric** | Premature for local single-user tool. Principals already share MCP tools via single process. Relevant for cloud/multi-tenant runtime. |
| **Enterprise Governance (RBAC, SSO, audit dashboards)** | Needs enterprise customers |
| **Cloud Runtime SaaS** | Needs operational infrastructure + cost modeling |
| **A2A Protocol v1.0** | Spec still stabilizing; our event bus + A2A tools are sufficient |
| **microVM isolation (gVisor/Firecracker)** | Needs Fabric/cloud runtime first |
| **Registry monetization** | Needs market validation |
| **Federated registries** | Single registry must mature first |
| **Agent commerce / payments** | Market not mature |
| **New hook points beyond the existing 22** | Existing hooks cover all known use cases; add only if proven necessary |

---

## 8. Definition of Done

Phase 2 is complete when:

1. All P0 success criteria (REG-001 through REG-027, SEC-001 through SEC-004, PERF-001 through PERF-002, DX-001 through DX-003) are implemented, tested, and documented
2. All quantitative KPIs meet or exceed targets
3. Public Registry is live at `https://pekohub.org` with ≥ 50 community bundles
4. Registry supports `.principal` and `.ext` as publishable OCI artifact types
5. At least 3 external teams (outside the core dev team) have successfully published bundles on the platform
6. Phase 2 retrospective is published

---

## 9. Document Reference

| Document | Purpose |
|----------|---------|
| `Phase2_Success_Criteria.md` | Complete, detailed success criteria with numbered requirements |
| `Phase2_Roadmap.md` (this document) | Implementation roadmap: execution order, milestones, architecture diagrams, design decisions |
| ADR-027 (`docs/architecture/adr/ADR-027-unified-packaging.md`) | Packaging format for `.agent`/`.team`/`.ext` |
| ADR-001 (`docs/architecture/adr/ADR-001-refresh-token-rotation.md`) | Refresh token rotation for long-lived sessions (SEC-002) |

---

*End of Phase 2 Roadmap v2.2*
