# ADR-008: Seeds are published as text; the OCI surface is retired

Date: 2026-11-01
Status: Accepted
Supersedes: the OCI distribution parts of ADR-005 and ADR-006
Counterpart: peko-runtime ADR-060 (seed), ADR-066 D7 (registry client deleted)
Context doc: `docs/GAP_MAP_2026-11.md` (S1)

## Context

The Hub is a seed registry. Snapshots (`.peko`) are too large to store at this stage and
stay local files. A seed is small: a `principal.toml` plus an optional `persona`, which
`peko create <name> -s <file>` grows into a new peko with a fresh identity.

The Hub received seeds only as OCI pushes: a zero-layer manifest whose config blob was the
stripped TOML, stored in S3. The only producer was the runtime's registry client
(`peko push`), and runtime ADR-066 D7 deleted it. Nothing could publish a seed any more.

## Decision

1. **Publish text.** `POST /v1/seeds { seed, version, readme? }`. The TOML is stored in
   `bundle_versions.content` (Postgres), with its SHA-256 as the digest. No blob storage.
2. **Name seeds `<publisher handle>/<name>`**, the same shape as a peko's share path. The
   name comes from the seed's `name`. The first publisher owns the name; versions are
   semver-shaped and immutable.
3. **The Hub refuses what belongs to an existence**: top-level `id`, `did`, `actor_key`,
   `owner`, `permissions`, `boot_state`, `status`, `exposure`, `children`. These match what
   `peko create -s` resets plus deployment state a seed must not impose (a seed that set
   `exposure = "public"` would publish every peko grown from it). It also refuses seeds
   over 64 KB and invalid TOML, with a message aimed at the publisher. `peko seed` exports
   a seed that passes.
4. **Read paths:** a listing, a detail (with the latest TOML), and a download as
   `<name>.seed.toml`. `latest` resolves to the newest non-deprecated version. Search and
   pull counts carry over.
5. **Retire OCI:** `/v2/*`, the `/v1/bundles/*` wildcard API, the `/api/v1` aliases, blob
   GC, and the shared OCI types. Rows pushed through OCI have no `content`; they stay in the
   database and are not listed. The storage plugin stays for future uploads (avatars,
   attachments).

## Consequences

- Publishing works from the website today. The desktop and CLI can publish through the same
  endpoint with their OAuth token (ADR-007).
- There are no signatures. Trust is the operator's, as runtime ADR-066 D7 decided: the seed
  page shows the TOML before download. Review, reports, and verified publishers are later
  work (gap map S5).
