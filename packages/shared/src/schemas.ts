import { z } from 'zod';
import {
  BundleTypes,
  ExtensionTypes,
  ModelProviders,
  Categories,
} from './constants.js';

// ─────────────────────────────────────────────────────────────────────────────
// Bundle Manifest (Pekohub-specific metadata embedded in OCI manifest)
// ─────────────────────────────────────────────────────────────────────────────

export const BundleMetadata = z.object({
  name: z.string().min(1).max(128),
  description: z.string().max(2000).optional(),
  author: z.string().min(1).max(256),
  license: z.string().max(64).optional().nullable(),
  tags: z.array(z.string().max(32)).max(20).optional(),
  categories: z.array(z.enum(Categories)).optional(),
  bundleType: z.enum(BundleTypes),
  extensionType: z.enum(ExtensionTypes).optional().nullable(),
  modelProviders: z.array(z.enum(ModelProviders)).optional(),
  requiredMcpServers: z.array(z.string()).optional(),
  homepage: z.string().url().optional().nullable(),
  repository: z.string().url().optional().nullable(),
  readme: z.string().max(50000).optional().nullable(),
  version: z.string().regex(
    /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/,
    'Invalid semantic version'
  ).or(z.literal('latest')).or(z.literal('')),
  deprecated: z.boolean().optional(),
  deprecatedMessage: z.string().optional().nullable(),
  forkedFrom: z.string().optional(),
});
export type BundleMetadata = z.infer<typeof BundleMetadata>;

// ─────────────────────────────────────────────────────────────────────────────
// API Request / Response Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const SearchQuery = z.object({
  q: z.string().min(1).max(200),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
  filters: z
    .object({
      bundleType: z.enum(BundleTypes).optional(),
      extensionType: z.enum(ExtensionTypes).optional(),
      modelProvider: z.enum(ModelProviders).optional(),
      category: z.enum(Categories).optional(),
      license: z.string().optional(),
    })
    .optional(),
});
export type SearchQuery = z.infer<typeof SearchQuery>;

export const SearchResultItem = z.object({
  namespace: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string().optional(),
  author: z.string(),
  bundleType: z.enum(BundleTypes),
  extensionType: z.enum(ExtensionTypes).optional(),
  tags: z.array(z.string()).optional(),
  pullCount: z.number().int().nonnegative(),
  starCount: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
});
export type SearchResultItem = z.infer<typeof SearchResultItem>;

export const SearchResponse = z.object({
  items: z.array(SearchResultItem),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  perPage: z.number().int().positive(),
  totalPages: z.number().int().nonnegative(),
});
export type SearchResponse = z.infer<typeof SearchResponse>;

export const BundleDetail = z.object({
  namespace: z.string(),
  name: z.string(),
  versions: z.array(
    z.object({
      version: z.string(),
      digest: z.string(),
      size: z.number().int().nonnegative(),
      createdAt: z.string().datetime(),
      deprecated: z.boolean().optional(),
      deprecatedMessage: z.string().optional().nullable(),
    })
  ),
  metadata: BundleMetadata,
  readme: z.string().optional().nullable(),
  pullCount: z.object({
    daily: z.number().int(),
    weekly: z.number().int(),
    monthly: z.number().int(),
    allTime: z.number().int(),
  }),
  installCommand: z.string(),
});
export type BundleDetail = z.infer<typeof BundleDetail>;

// ─────────────────────────────────────────────────────────────────────────────
// Auth Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const OAuthProvider = z.enum(['github', 'google']);
export type OAuthProvider = z.infer<typeof OAuthProvider>;

export const UserProfile = z.object({
  id: z.string(),
  namespace: z.string(),
  displayName: z.string(),
  email: z.string().email().optional(),
  avatarUrl: z.string().url().optional(),
  createdAt: z.string().datetime(),
});
export type UserProfile = z.infer<typeof UserProfile>;

export const ApiKey = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  createdAt: z.string().datetime(),
  lastUsedAt: z.string().datetime().optional(),
});
export type ApiKey = z.infer<typeof ApiKey>;

// ─────────────────────────────────────────────────────────────────────────────
// Extension-specific Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const HookPoint = z.enum([
  'agent.init',
  'agent.shutdown',
  'agent.iteration',
  'tool.register',
  'tool.execute',
  'tool.executeAsync',
  'tool.resultTransform',
  'event.subscribe',
  'event.emit',
  'prompt.systemSection',
  'prompt.userSection',
  'prompt.assistantSection',
  'session.stateChange',
  'session.contextBuild',
  'session.branch',
  'session.overlay',
  'memory.store',
  'memory.retrieve',
  'mcp.serverRegister',
  'mcp.toolDiscover',
  'cron.schedule',
  'cron.tick',
]);
export type HookPoint = z.infer<typeof HookPoint>;

export const ExtensionManifest = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, 'Extension ID must be kebab-case'),
  name: z.string().min(1).max(128),
  version: z.string(),
  extensionType: z.enum(ExtensionTypes),
  description: z.string().max(2000).optional(),
  hooks: z.array(
    z.object({
      point: HookPoint,
      handler: z.string().optional(),
      topicPattern: z.string().optional(),
    })
  ),
  compatibility: z
    .object({
      runtime: z.string().optional(),
      minVersion: z.string().optional(),
      maxVersion: z.string().optional(),
    })
    .optional(),
});
export type ExtensionManifest = z.infer<typeof ExtensionManifest>;
