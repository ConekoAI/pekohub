/**
 * OCI Distribution Spec constants
 * https://github.com/opencontainers/distribution-spec/blob/main/spec.md
 */

export const OCI_VERSION = 'v2';

export const MediaTypes = {
  // Manifests
  OCI_MANIFEST: 'application/vnd.oci.image.manifest.v1+json',
  OCI_INDEX: 'application/vnd.oci.image.index.v1+json',
  // Pekohub-specific
  //
  // ADR-041 collapses agent + team into the Principal packaging
  // surface; `.principal` is the only top-level bundle format
  // (extensions remain a separate kind for compatibility).
  PEKO_PRINCIPAL_MANIFEST: 'application/vnd.pekohub.principal.manifest.v1+json',
  PEKO_EXTENSION_MANIFEST: 'application/vnd.pekohub.extension.manifest.v1+json',
  // Config + layers
  OCI_CONFIG: 'application/vnd.oci.image.config.v1+json',
  PEKO_LAYER_TAR: 'application/vnd.pekohub.layer.v1.tar+gzip',
} as const;

// Bundle kinds (ADR-041 clean break). 'agent' and 'team' are
// intentionally absent — the runtime ships them as `Principal`
// packages now, and the OCI annotation `dev.pekohub.bundleType`
// rejects `agent`/`team` with `410 Gone` on PUT.
export const BundleTypes = ['principal', 'extension'] as const;
export type BundleType = (typeof BundleTypes)[number];

export const ExtensionTypes = [
  'skill',
  'mcp',
  'gateway',
  'universal',
  'general',
] as const;
export type ExtensionType = (typeof ExtensionTypes)[number];

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
