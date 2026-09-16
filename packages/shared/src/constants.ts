/**
 * OCI Distribution Spec constants
 * https://github.com/opencontainers/distribution-spec/blob/main/spec.md
 *
 * PekoHub is a **template-only** registry. Per peko-runtime ADR-056 D6 a
 * pushed artifact is DNA: a zero-layer OCI manifest whose config blob is
 * a stripped `principal.toml`. There is no extension package format and
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
  // A pushed template is a zero-layer OCI manifest whose config blob is
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
  // Coarse classification only; template identity is the repo path plus
  // `org.peko.{name,version}`. `categories` / `modelProviders` /
  // `requiredMcpServers` / `hooks` / `compatibility` were extension-era
  // package metadata and are gone.
  DEV_PEKOHUB_TAGS: 'dev.pekohub.tags',
  DEV_PEKOHUB_README: 'dev.pekohub.readme',
} as const;

/**
 * Bundle kinds.
 *
 * `principal` is the wire value for a template; the UI calls it a
 * template and the runtime calls the actor a peko, but per pekohub
 * ADR-005 §1 the machine vocabulary keeps the pre-pivot spelling.
 *
 * `extension` is intentionally absent: capability distribution moved to
 * workspace files (runtime ADR-047 §5 / ADR-050) and the registry is
 * template-only (ADR-056 D6). A push carrying it is rejected with
 * `410 Gone`. `agent`/`team` were already retired by ADR-041.
 */
export const BundleTypes = ['principal'] as const;
export type BundleType = (typeof BundleTypes)[number];
