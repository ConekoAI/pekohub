/**
 * OCI Distribution Spec constants
 * https://github.com/opencontainers/distribution-spec/blob/main/spec.md
 *
 * PekoHub is a **seed-only** registry. Per peko-runtime ADR-056 D6 a
 * pushed artifact is DNA: a zero-layer OCI manifest whose config blob is
 * a stripped `principal.toml`. Per peko-runtime ADR-060 that artifact is
 * called a **seed** — it mints a fresh identity every time it is
 * ground, so it is never a copy of its source the way a seed would
 * be. There is no extension package format and
 * no `.peko`/`.agent` bundle format on the wire — the standalone
 * extension framework (runtime ADR-017/024/027/036) was superseded by
 * workspace-file capabilities (ADR-047 §5, ADR-050), and ADR-037 retired
 * the `.agent` composite bundle.
 */

export const OCI_VERSION = 'v2';

export const MediaTypes = {
  // Manifests
  OCI_MANIFEST: 'application/vnd.oci.image.manifest.v1+json',
  OCI_INDEX: 'application/vnd.oci.image.index.v1+json',
  // Config + layers
  //
  // A pushed seed is a zero-layer OCI manifest whose config blob is
  // a stripped `principal.toml` under PEKO_CONFIG (the runtime's
  // `PEKO_CONFIG_MEDIA_TYPE`). Full-existence `.peko` snapshots never
  // transit the hub.
  OCI_CONFIG: 'application/vnd.oci.image.config.v1+json',
  PEKO_CONFIG: 'application/vnd.peko.config.v1+json',
  PEKO_LAYER_TAR: 'application/vnd.pekohub.layer.v1.tar+gzip',
} as const;

// OCI manifest annotation keys emitted by the runtime
// (peko-runtime peko-rs/core/src/registry/manifest.rs).
//
// The hub's own `dev.pekohub.bundleType` is retained *only* as a
// rejection guard: a push that spells the kind there (rather than in
// `org.peko.kind`) is an older client, and any value other than
// `principal` is answered with 410 Gone rather than silently re-typed.
// See `deriveBundleType` in `backend/src/routes/oci/manifests.ts`.
//
// NOTE: the wire values below are deliberately NOT renamed by ADR-060.
// Deployed runtimes consume them, so a rename needs a versioned overlap
// window (ADR-059 §6 precedent) — the same reason the `bundles` tables
// and the `/v1/bundles` API paths keep their names.
export const OCIAnnotations = {
  ORG_PEKO_NAME: 'org.peko.name',
  ORG_PEKO_VERSION: 'org.peko.version',
  // `principal` is the only accepted value: the runtime's push path
  // hard-codes `.with_kind("principal")`, so `extension` is a retired
  // spelling (ADR-047 §5 / ADR-050) and `agent`/`team` were dropped by
  // ADR-041.
  ORG_PEKO_KIND: 'org.peko.kind',
  DEV_PEKOHUB_BUNDLE_TYPE: 'dev.pekohub.bundleType',
  DEV_PEKOHUB_PRINCIPAL_NAME: 'dev.pekohub.principalName',
  // Coarse classification only; seed identity is the repo path plus
  // `org.peko.{name,version}`. `categories` / `modelProviders` /
  // `requiredMcpServers` / `hooks` / `compatibility` were extension-era
  // package metadata and are gone.
  DEV_PEKOHUB_TAGS: 'dev.pekohub.tags',
  DEV_PEKOHUB_README: 'dev.pekohub.readme',
} as const;

/**
 * Bundle kinds.
 *
 * `principal` is the wire value for a seed. Before ADR-060 the three
 * vocabularies disagreed — the wire said `principal`, the UI said
 * "seed", and the runtime called the actor a peko. ADR-060 collapsed
 * the UI term onto "seed"; per pekohub ADR-005 §1 the machine vocabulary
 * keeps the pre-pivot spelling, so the wire value is unchanged.
 *
 * `extension` is intentionally absent: capability distribution moved to
 * workspace files (runtime ADR-047 §5 / ADR-050) and the registry is
 * seed-only (ADR-056 D6). A push carrying it is rejected with
 * `410 Gone`. `agent`/`team` were already retired by ADR-041.
 */
export const BundleTypes = ['principal'] as const;
export type BundleType = (typeof BundleTypes)[number];
