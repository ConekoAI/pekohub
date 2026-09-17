# ADR-006: "Seed" Terminology on the Hub

**Status:** Accepted (2026-09-17). Implemented on branch
`rename/template-to-seed`.
**Date:** 2026-09-17
**Deciders:** rlsn
**Related:** [ADR-005](ADR-005-peko-realignment.md) (registry
realignment — the wire vocabulary this ADR leaves intact), peko-runtime
ADR-056 D6 (the registry distributes DNA),
peko-runtime ADR-060 (the upstream decision this ADR implements),
peko-runtime ADR-059 (user-facing term policy).

---

## Context

The hub's machine vocabulary, its UI vocabulary, and the runtime's noun
for the artifact have disagreed since the ADR-005 realignment. ADR-005 §1
records the split explicitly: the wire says `principal`, the database
table says `bundles`, the UI says "template", and the runtime calls the
actor a peko.

peko-runtime ADR-060 resolves the terminology upstream: the artifact is
a **seed**. A pushed artifact mints a fresh identity every time it is
ground, so it is never a copy of its source — which is what "template"
implies and which the artifact does not do.

## Decision

Adopt "seed" for the hub's **user-facing** vocabulary.

1. **Routes.** `frontend/src/routes/templates/` → `routes/seeds/`, with
   route ids `/seeds` and `/seeds/$`. New component `SeedCard`, new
   hooks `useSeed` / `useSeedVersions` / `useSeedCatalog`, new lib
   symbols `SEED_LANE`, `isSeed`, `SeedVersion`, `SeedVersionsResponse`.

2. **Legacy URLs.** `/templates` was public, so
   `routes/templates_.$.tsx` answers it with a `replace` redirect to
   `/seeds`. The existing `/bundles/*` redirect is retargeted to skip
   straight to `/seeds` — both hops resolve in one step.

3. **Published artifact name.** The copy-paste command the detail page
   offers becomes `peko create my-peko -s <name>.seed.toml`.

4. **Copy and error strings.** UI copy, page headings, and the
   publisher-facing 4xx messages say "seed" ("PekoHub is a seed-only
   registry…", "Seed not found").

5. **Unchanged by design** — the machine vocabulary, per ADR-005 §1 and
   the ADR-059 §5/§6 precedent:
   - OCI wire values: `org.peko.kind = "principal"`, the
     `peko/principals/<name>` repo lane, media types.
   - REST paths: `/v1/bundles/*`, `/v2/_catalog`.
   - Database tables: `bundles`, `bundle_versions`, `blobs`.
   - The `BundleTypes` wire union and the `dev.pekohub.*` annotation keys.

   Deployed runtimes consume these, so renaming them needs a versioned
   overlap window. They are deferred to a future major version.

6. **`seed` in the cryptographic sense is untouched.** `bridgeSigningSeed`
   derives an ed25519 key seed from the JWT secret — a different
   concept. Because the word now carries two meanings in this codebase,
   the peko sense must always be **qualified**: `SEED_LANE`, `SeedCard`,
   `useSeed`, `seedManifest` — never a bare `seed`.

Historical ADR-005 and the ADR-056/059 references inside it are
immutable records and keep their wording.

## Consequences

- The hub no longer needs the apology recorded in `constants.ts`: the UI
  noun, the runtime noun, and the conceptual model all say seed. Only
  the wire keeps the pre-pivot spelling, which is now a documented,
  single, deliberate exception rather than a three-way disagreement.
- Existing `/templates` bookmarks and inbound links keep working via the
  redirect. No database migration is required.
- `/v1/bundles/*` and `org.peko.kind = "principal"` stay as they are, so
  every deployed runtime continues to push and pull unchanged.
- `backend/tests/integration/oci-template-push.test.ts` is renamed to
  `oci-seed-push.test.ts`; its `TEMPLATE_TOML` fixture constant becomes
  `SEED_TOML`. The assertions that pin the 4xx wording were updated in
  the same change.
