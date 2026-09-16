/**
 * OCI Distribution Spec constants
 * https://github.com/opencontainers/distribution-spec/blob/main/spec.md
 */

export const OCI_VERSION = 'v2';

export const MediaTypes = {
  // Manifests
  OCI_MANIFEST: 'application/vnd.oci.image.manifest.v1+json',
  OCI_INDEX: 'application/vnd.oci.image.index.v1+json',
  // Pekohub-specific (legacy hub media types — the runtime pushes
  // plain OCI manifests today; keep accepting these for older CLI
  // builds).
  PEKO_PRINCIPAL_MANIFEST: 'application/vnd.pekohub.principal.manifest.v1+json',
  PEKO_EXTENSION_MANIFEST: 'application/vnd.pekohub.extension.manifest.v1+json',
  // Config + layers
  //
  // ADR-056 (peko-runtime): a pushed principal is a *template* — a
  // zero-layer OCI manifest whose config blob is a stripped
  // `principal.toml` carried under PEKO_CONFIG (the runtime's
  // `PEKO_CONFIG_MEDIA_TYPE`). Full-existence `.peko` snapshots never
  // transit the hub.
  OCI_CONFIG: 'application/vnd.oci.image.config.v1+json',
  PEKO_CONFIG: 'application/vnd.peko.config.v1+json',
  PEKO_LAYER_TAR: 'application/vnd.pekohub.layer.v1.tar+gzip',
} as const;

// OCI manifest annotation keys emitted by the runtime
// (peko-runtime peko-rs/core/src/registry/manifest.rs).
export const OCIAnnotations = {
  ORG_PEKO_NAME: 'org.peko.name',
  ORG_PEKO_VERSION: 'org.peko.version',
  // 'principal' | 'extension' | 'agent' — alias source for bundleType
  // when `dev.pekohub.bundleType` is absent.
  ORG_PEKO_KIND: 'org.peko.kind',
  DEV_PEKOHUB_BUNDLE_TYPE: 'dev.pekohub.bundleType',
  DEV_PEKOHUB_PRINCIPAL_NAME: 'dev.pekohub.principalName',
  DEV_PEKOHUB_EXTENSION_ID: 'dev.pekohub.extensionId',
} as const;

// Bundle kinds (ADR-041 clean break). 'agent' and 'team' are
// intentionally absent — the runtime ships them as `Principal`
// packages now, and the OCI annotation `dev.pekohub.bundleType`
// rejects `agent`/`team` with `410 Gone` on PUT. Per ADR-059 the
// machine value stays `principal` even though UX says "peko".
export const BundleTypes = ['principal', 'extension'] as const;
export type BundleType = (typeof BundleTypes)[number];

// Standard extension types — mirror peko-runtime
// `peko-rs/core/src/extensions/mod.rs extension_types::*`
// (`standard_types()`). `builtin` is intentionally absent: built-in
// tools are framework-internal, not manifest-declarable. `gateway`
// (sprint 9) and `slash` are retired runtime-side and are rejected
// here too.
export const ExtensionTypes = [
  'skill',
  'agent',
  'mcp',
  'universal-tool',
  'general',
] as const;
export type ExtensionStandardType = (typeof ExtensionTypes)[number];

// Custom extension type prefix — peko-runtime's
// `extension_types::CUSTOM_PREFIX`. Custom types are validated against
// the `CUSTOM_EXTENSION_PATTERN` regex below.
export const CUSTOM_EXTENSION_PREFIX = 'custom:' as const;

// Matches peko-runtime's runtime check for `custom:<id>`:
// `extension_types::is_valid_type` accepts any string starting with
// the prefix and validates the suffix separately. Pekohub requires the
// suffix to be lowercase kebab/slash/dot/underscore (e.g. "custom:my-org/skill").
export const CUSTOM_EXTENSION_PATTERN = /^custom:[a-z0-9][a-z0-9._/-]*$/;

export type ExtensionType = ExtensionStandardType | `custom:${string}`;

export const ModelProviders = [
  'openai',
  'anthropic',
  'google',
  'local',
  'azure',
] as const;
export type ModelProvider = (typeof ModelProviders)[number];

export const Categories = [
  'research',
  'support',
  'development',
  'content',
  'data',
  'automation',
] as const;
export type Category = (typeof Categories)[number];
