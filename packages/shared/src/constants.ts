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
  PEKO_AGENT_MANIFEST: 'application/vnd.pekohub.agent.manifest.v1+json',
  PEKO_TEAM_MANIFEST: 'application/vnd.pekohub.team.manifest.v1+json',
  PEKO_EXTENSION_MANIFEST: 'application/vnd.pekohub.extension.manifest.v1+json',
  // Config + layers
  OCI_CONFIG: 'application/vnd.oci.image.config.v1+json',
  PEKO_LAYER_TAR: 'application/vnd.pekohub.layer.v1.tar+gzip',
} as const;

export const BundleTypes = ['agent', 'team', 'extension'] as const;
export type BundleType = (typeof BundleTypes)[number];

export const ExtensionTypes = [
  'skill',
  'mcp',
  'gateway',
  'universal',
  'general',
  'team',
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
