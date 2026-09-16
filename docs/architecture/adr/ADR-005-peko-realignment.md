# ADR-005: Peko Realignment — Terminology, Template Registry, and Single-Exposure Enforcement

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-09-16 |
| **Depends On** | ADR-002 (Remote Instance Management API), ADR-003 (Exposure Modes), ADR-004 (Tunnel Server), ADR-042 (Principal-as-Container v2) |
| **Related** | peko-runtime ADR-050 (Capabilities as Workspace Files), ADR-054 (Genesis Pipeline), ADR-055 (Principal KB), ADR-056 (Full-Existence Snapshot), ADR-057 (Single-Attribution Identity), ADR-058 (Origin-Signed Messaging), ADR-059 ("Peko" as the User-Facing Term); peko-runtime `docs/architecture/PEKO.md` |

---

## Context

The companion runtime has completed a series of pivots that the hub must absorb:

- **ADR-054 / ADR-055 / PEKO.md**: the unit users manage is now a **PEKO** (Persistent Entity with Keepalive Orchestration) — a did:key identity + `kb/` knowledge base + `principal.toml` governance + workspace capabilities (presence = visibility, ADR-050) + a root agent, created through the genesis pipeline (boot_state `provisioned` → `defined` → `genesis_pending` → `organized`).
- **ADR-056**: full-existence `.peko` snapshots are the archive format, and they move **peer-to-peer only — never via the hub**. Registry push (ADR-056 D6) is recast as *template distribution*: a zero-layer OCI manifest whose config blob is a stripped `principal.toml` (media type `application/vnd.peko.config.v1+json`), annotated `org.peko.{name,version,kind}` + `dev.pekohub.*`, under multi-segment repo paths `peko/{principals,extensions,agents}/<name>`. ADR-056 D7 caps exposure at one public/unlisted instance per principal DID.
- **ADR-059**: the user-facing term is **"peko"** (lowercase, "a peko"). The CLI namespace collapses to flattened verbs (`peko create|list|show|remove|export|import|push|pull|permit|revoke|permissions|invite|revoke-invite|diff`); `peko principal <sub>` survives as a hidden alias. All machine/wire names keep "principal".

PekoHub's web endpoints, SPA routes, OCI surface, and docs still reflect the pre-pivot naming and the pre-D6 packaging model. This ADR records the hub-side realignment.

---

## Decision

### 1. Terminology split: wire "principal", UX "peko"

The hub adopts the runtime's ADR-059 split:

| Surface | Term |
|---|---|
| User-facing web endpoints | `GET /v1/public/pekos/:owner/:pekoName` and `POST /v1/public/pekos/:owner/:pekoName/chat` (renamed from the `/v1/public/principals/...` variants — clean rename, **no aliases**) |
| "Shared with me" listing | `GET /v1/me/accessible-pekos` (replaces the `/v1/me/accessible-principals` variant — clean rename, no aliases) |
| SPA share URL | Canonical `/peko/:owner/:name`; legacy `/p/:owner/:name` kept as a **redirect** |
| Tunnel JSON fields, OCI annotations (`dev.pekohub.principalName`, `dev.pekohub.bundleType:"principal"`), registry repo paths (`peko/principals/<name>`), hub directory API (`/v1/principals/by-did/:did`, `/v1/principals/by-handle/:owner/:name`), DB columns, audit events | unchanged — "principal" |

### 2. Registry is template-only

- Pushed artifacts are **templates**, not existences: zero-layer OCI manifest, config blob = stripped `principal.toml` (media type `application/vnd.peko.config.v1+json`), annotations `org.peko.{name,version,kind}` + `dev.pekohub.*`. `.peko` full-existence snapshots are never accepted or served by the hub (ADR-056 D6).
- `/v2` OCI routes accept **multi-segment repo paths**: `peko/{principals,extensions,agents}/<name>`.
- **Publisher ownership**: `bundles.publisher_id` is claimed on first push; only the publisher may write thereafter. `namespace == user.namespace` is retained only as a legacy fallback for pre-ownership rows.
- **Blob uploads now require auth** (previously anonymous).
- An **`/api/v1/*` alias surface** (search, bundles, auth) is exposed for the CLI alongside the canonical routes.

### 3. D7 single-exposure enforcement

At most **one public or unlisted instance per principal DID** (ADR-056 D7). A conflicting announce/exposure transition returns **409 Conflict**.

### 4. What stays unchanged

- The **ADR-057/058 security surface** as already implemented hub-side: EdDSA bridge tokens (60s, mandatory `kind:"user"|"visitor"` claim), JWKS at `/v1/jwks.json`, PoP runtime registration (`POST /v1/runtimes/register-challenge` → `POST /v1/runtimes/register` with JWS PoP), `principalPop` on `instance_announce`, HMAC-signed visitor cookies.
- The **pure-relay posture**: the hub relays `tunnel_channel_event` / `tunnel_channel_invite` and their dual JWS signatures pass through **unverified**.
- The **`/v1/principals/*` directory API** (`by-did`, `by-handle`) — wire names stay "principal" per §1.

---

## Consequences

### Breaking

- `GET/POST /v1/public/principals/:owner/:name(+/chat)` and `GET /v1/me/accessible-principals` are **gone** — no compatibility aliases. Web clients must move to the `/pekos` variants.
- Anonymous blob upload is gone; CLI/registry clients must authenticate before `POST /v2/.../blobs/uploads`.
- Second public/unlisted exposure of the same principal DID fails with 409 instead of silently coexisting.

### Preserved

- `/p/:owner/:name` SPA URLs **redirect** to `/peko/:owner/:name`; existing shared links survive.
- `peko principal <sub>` CLI invocations keep working (hidden alias, runtime side).
- Pre-ownership bundles remain writable by their namespace owner via the legacy `namespace == user.namespace` fallback.

### Operator note

The drizzle migration chain has been **squashed to a fresh baseline**. There is no incremental upgrade path from a pre-baseline database: provision a new database from the baseline migration (or dump/restore data manually). The stale `backend/test-bundle/` fixture directory was deleted in the same pass.

---

## Reasoning

- **Clean rename, no aliases, on the web surface**: the `/v1/public/principals/*` endpoints were young and low-traffic; carrying aliases would fossilize the wrong term in exactly the place ADR-059 wants it gone. The SPA redirect for `/p/...` is cheap and preserves shared links, which is where real breakage would hurt.
- **Template-only registry** follows directly from ADR-056 D6: the hub must never be a vehicle for full existences (keys, memory, sessions). Accepting only the stripped `principal.toml` config blob makes the hub safe to operate as a public distribution point.
- **`publisher_id` over namespace matching**: multi-segment repo paths (`peko/principals/<name>`) decouple the repo path from the publisher's namespace, so ownership must be an explicit claimed column, not a string comparison.
- **D7 at the hub**: single-exposure is a distribution-integrity rule; enforcing it at announce time in the hub is the one place all runtimes must pass through.

---

## References

- peko-runtime `docs/architecture/PEKO.md` — the PEKO primitive
- peko-runtime ADR-054 (genesis pipeline), ADR-055 (principal KB), ADR-056 (full-existence snapshot; D6 template registry, D7 single exposure), ADR-059 ("peko" as user-facing term)
- peko-runtime ADR-057 (single-attribution identity), ADR-058 (origin-signed messaging)
- ADR-002, ADR-003, ADR-004, ADR-042 (this repository, amended 2026-09-16)
