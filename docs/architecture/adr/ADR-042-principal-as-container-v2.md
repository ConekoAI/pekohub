# ADR-042: Principal-as-Container v2 — PekoHub Adoption

**Status:** Proposed
**Date:** 2026-06-28
**Author:** rlsn
**Supersedes / Deprecates:** [ADR-039](./ADR-039-principal-aware-instance-owner.md). The Subject enum and the typed `owner_subject` column are now the only source of truth; the legacy `Principal` enum (`User` / `Agent` / `Team` / `Public`) and the legacy `allowed_users` / `agent_did` columns are removed.
**Related:** [peko-runtime ADR-041](https://github.com/ConekoAI/peko-runtime/blob/main/docs/architecture/adr/ADR-041-principal-as-container.md) (the runtime-side refactor that ships with #82), [peko-runtime ADR-039](https://github.com/ConekoAI/peko-runtime/blob/main/docs/architecture/adr/ADR-039-principal-model.md) (the original Principal model).

---

## 1. Context

The runtime has shipped Principal-as-Container (#82, commit 9031a27). PekoHub is the broker between the runtime and the wider world; its on-the-wire actor enum (`Principal`), the database columns it writes, and the OCI bundle type catalog it advertises all need to match the new model. This ADR documents PekoHub's v2 cut.

PekoHub sits between two audiences:
- **Runtimes** talk to PekoHub over the tunnel to register their Principal-as-container instances and to forward cross-runtime chat/streaming.
- **Hubs/clients** talk to PekoHub over HTTP to discover, install, and chat with published Principals.

Both surfaces need to be consistent with the runtime's wire format.

## 2. Decision

### 2.1 Subject enum (the actor)

The shared `principal.ts` package is renamed to `subject.ts`. The variants change:

| ADR-039 (old) | ADR-042 (new) |
|---|---|
| `Principal::User(id)` | `Subject::User(id)` |
| `Principal::Agent(id)` | `Subject::Principal(id)` |
| `Principal::Team(id)` | _removed_ (clean break) |
| `Principal::Public` | `Subject::Public` |

The wire token `agent:` becomes `principal:`. PekoHub emits `principal:` in `x-pekohub-caller-principal` and accepts `principal:` in inbound allow-list entries. `team:` is rejected (`null` on parse) so a stray wire token from a pre-#82 client surfaces as a clean error instead of a silent ACL bypass.

### 2.2 `.principal` package format

The `BundleTypes` union drops `agent` and `team` and gains `principal`. The `ExtensionTypes` union drops `team` (a `team` extension was a placeholder for a feature that ADR-041 explicitly defers to a follow-up ADR).

OCI PUTs that carry `dev.pekohub.bundleType=agent` (or `team`) return `410 Gone` with a clear error message. The new `PEKO_PRINCIPAL_MANIFEST` media type (`application/vnd.pekohub.principal.manifest.v1+json`) is the only top-level package format post-#82.

### 2.3 Multi-step DB migration

Four small migrations apply cleanly on a half-applied state (a hot-fix can run each step independently):

| File | What it does |
|---|---|
| `0008a_add_principal_did.sql` | Adds `principal_did` column + unique index, backfills from `agent_did`. |
| `0008b_replace_team_with_principal.sql` | Widens `instances.type` to `varchar(16)`, rewrites `type='team'` rows to `'principal'`. |
| `0008c_rename_allowed_columns.sql` | Renames `allowed_users` → `allowed_principals` and backfills the legacy bare-string array to the typed `Subject[]` shape. |
| `0008d_drop_agent_did.sql` | Drops the legacy `agent_did` column and its unique index. |

The runtime's `principal_did` (post-#82) is the authoritative key for the by-did resolver. Pre-#82 rows that still have an `agent_did` continue to be addressable by the by-did endpoint until `0008d` is applied.

### 2.4 Hook surface

The `HookPoint` Zod enum gains 13 principal-layer hook variants (`principal.init`, `principal.shutdown`, `principal.iteration`, `principal.send`, `principal.receive`, `principal.permissionGrant`, `principal.permissionRevoke`, `principal.memory.store`, `principal.memory.retrieve`, `principal.router.decide`, `principal.router.fallback`, `principal.session.fork`, `principal.session.gc`). The 22 agent-layer hooks remain for extensions that fire on a single agent run.

## 3. PekoHub backend deltas

| File | Change |
|---|---|
| `packages/shared/src/principal.ts` | **renamed** → `subject.ts` |
| `packages/shared/src/constants.ts` | `BundleTypes = ['principal', 'extension']`; `PEKO_PRINCIPAL_MANIFEST` added; `PEKO_AGENT_MANIFEST`/`PEKO_TEAM_MANIFEST` removed; `ExtensionTypes` drops `team` |
| `packages/shared/src/schemas.ts` | `HookPoint` gains the 13 principal-layer variants |
| `packages/shared/src/target-spec.ts` | `AgentDID` → `PrincipalDID` (`did:peko:principal:<keyhash>`); `agentName` → `principalName` |
| `backend/src/db/schema.ts` | `instances.type = 'principal'`, `principalDid` replaces `agentDid`, `ownerSubject: jsonb('owner_subject')`, `allowedPrincipals: jsonb('allowed_principals')` (no more `allowedUsers`) |
| `backend/src/routes/api/agents.ts` | **renamed** → `principals.ts`; routes `/v1/principals/by-did/:did`, `/v1/principals/by-handle/:owner/:principal_name` |
| `backend/src/services/instances.ts` | `InstanceType = 'principal'`; `resolveOwnerSubject` (was `resolveOwnerPrincipal`); `subjectCanAccess` drops the `Team` branch and the `teamMembers` parameter |
| `backend/src/services/tunnel-protocol.ts` | `agent_to_agent_*` → `principal_to_principal_*`; `callerAgentDid` → `callerPrincipalDid`; `targetAgentDid` → `targetPrincipalDid` |
| `backend/src/services/tunnel-manager.ts` | Same renames; `callerAgent: Subject` (was `callerAgent: Principal`) |
| `backend/src/services/tunnel-router.ts` | `bridgeHeadersFor` writes `x-pekohub-caller-principal: principal:<id>` (was `agent:<id>`) |
| `backend/src/routes/oci/manifests.ts` | `bundleType` annotation must be `principal` or `extension`; legacy `agent`/`team` returns 410 |

## 4. PekoHub frontend deltas

| File | Change |
|---|---|
| `src/lib/api.ts` | `/v1/agents/` → `/v1/principals/`; `/v1/teams/` → `/v1/principals/` (the by-did and by-handle endpoints cover both kinds) |
| `src/hooks/` | `agents.ts` → `principals.ts`; React Query keys `['principals', ...]` |
| `src/routes/_layout/` | `agents/` → `principals/`; `teams/` removed |
| `src/components/BundleTypeBadge.tsx` | `agent` → `principal` |
| `src/routes/index.tsx` | "Discover & Share Agents" → "Discover & Share Principals" |

## 5. PekoHub test deltas

| File | Change |
|---|---|
| `tests/integration/agent_directory.test.ts` | **renamed** → `principal_directory.test.ts`; `agent:` → `principal:`; asserts `x-pekohub-caller-principal` reads `principal:<id>` |
| `tests/integration/agent_forwarding.test.ts` | Same renames |
| `tests/unit/principal-can-access.test.ts` | **renamed** → `subject-can-access.test.ts`; drops all `kind: 'team'` test cases |
| `tests/unit/principal-jsonb-parsers.test.ts` | **renamed** → `subject-jsonb-parsers.test.ts` |
| `tests/unit/target-spec.test.ts` | `AgentDID` → `PrincipalDID`; `agentName` → `principalName`; DIDs in fixtures are `did:peko:principal:` |

## 6. Consequences

### Positive

- The hub wire format matches the runtime's `Subject` and `principal:` token. A pre-#82 desktop client is the only thing that breaks, and per the ADR-041 plan there is no in-place migration.
- The `principal_did` column becomes the authoritative by-did key; the legacy `agent_did` is gone after `0008d`.
- One OCI package format (`.principal`) replaces two (`.agent` + `.team`).
- The `HookPoint` enum now matches the runtime's full hook surface (agent + principal layer).

### Negative

- Pre-#82 runtimes (those that haven't pulled peko-runtime #82) cannot register instances on the new hub. They return 410 on `bundleType=agent` and 403 on `team`-shaped ACL entries.
- A half-applied migration is queryable but the by-did resolver returns 404 on `principal_did IS NULL` until the runtime re-announces with the new field.

## 7. Out of scope

- Team-as-Principal semantics (deferred to a follow-up ADR per peko-runtime ADR-041 §6).
- Principal discovery and registry versioning (peko-runtime ADR-041 §6).
- Pekohub agent-prompt install flow (a `peko agent-prompt install …` UX is a follow-up; out of scope for v2).
