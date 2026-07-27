import { z } from 'zod';
import {
  BundleTypes,
  ExtensionTypes,
  CUSTOM_EXTENSION_PREFIX,
  CUSTOM_EXTENSION_PATTERN,
  ModelProviders,
  Categories,
} from './constants.js';

// ─────────────────────────────────────────────────────────────────────────────
// Extension-specific types (defined early for use in BundleMetadata)
// ─────────────────────────────────────────────────────────────────────────────

const nullishToUndefined = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((val) => (val === null ? undefined : val), schema);

// Runtime-aligned hook point string. Mirrors peko-runtime's
// `HookPoint::name()` / `HookPoint::matches()` format
// (src/extensions/framework/core/hook_points.rs).
//
// Three forms are accepted:
//   1. Base form — one of the 23 runtime hook point names
//      (e.g. "agent.init", "tool.execute", "session.compaction")
//   2. Parameterized form — base + concrete 3rd segment
//      (e.g. "tool.execute.Read", "prompt.system_section.skills",
//      "event.subscribe.instance.created", "agent.iteration.3")
//   3. Wildcard form — base + ".*"
//      (e.g. "tool.execute.*", "session.*", "*")
//
// Rejected: anything not under one of the six runtime hook categories
// (prompt / tool / session / io / event / agent).
export const HookPoint = z.string().regex(
  /^(?:prompt|tool|session|io|event|agent)\.[a-z_]+(?:\.[A-Za-z0-9_*]+)?$/,
  'Hook point must be a peko-runtime HookPoint::name() string ' +
    '(e.g. "agent.init", "tool.execute.Read", "session.*")',
);
export type HookPoint = z.infer<typeof HookPoint>;

// Extension type validator: any of the 7 standard peko-runtime types,
// or a "custom:<id>" string validated against CUSTOM_EXTENSION_PATTERN.
export const ExtensionTypeSchema = z.union([
  z.enum(ExtensionTypes),
  z
    .string()
    .regex(CUSTOM_EXTENSION_PATTERN, `Custom extension type must be "${CUSTOM_EXTENSION_PREFIX}<id>" with lowercase kebab/slash/dot/underscore id`),
]);

// ─────────────────────────────────────────────────────────────────────────────
// Bundle Manifest (Pekohub-specific metadata embedded in OCI manifest)
// ─────────────────────────────────────────────────────────────────────────────

export const BundleMetadata = z.object({
  name: z.string().min(1).max(128),
  description: z.string().max(2000).optional(),
  author: z.string().min(1).max(256),
  license: z.string().max(64).optional().nullable(),
  tags: nullishToUndefined(z.array(z.string().max(32)).max(20).optional()),
  categories: nullishToUndefined(z.array(z.enum(Categories)).optional()),
  bundleType: z.enum(BundleTypes),
  extensionType: ExtensionTypeSchema.optional().nullable(),
  modelProviders: nullishToUndefined(z.array(z.enum(ModelProviders)).optional()),
  requiredMcpServers: nullishToUndefined(z.array(z.string()).optional()),
  homepage: z.string().url().optional().nullable(),
  repository: z.string().url().optional().nullable(),
  readme: z.string().max(50000).optional().nullable(),
  hooks: nullishToUndefined(
    z.array(
      z.object({
        point: HookPoint,
        handler: z.string().optional(),
        topicPattern: z.string().optional(),
      })
    ).optional()
  ),
  compatibility: z
    .object({
      runtime: z.string().optional(),
      minVersion: z.string().optional(),
      maxVersion: z.string().optional(),
    })
    .optional(),
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
      extensionType: ExtensionTypeSchema.optional(),
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
  extensionType: ExtensionTypeSchema.optional(),
  tags: nullishToUndefined(z.array(z.string()).optional()),
  pullCount: z.number().int().nonnegative(),
  starCount: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
  hooks: nullishToUndefined(
    z.array(
      z.object({
        point: HookPoint,
        handler: z.string().optional(),
        topicPattern: z.string().optional(),
      })
    ).optional()
  ),
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

// ─────────────────────────────────────────────────────────────────────────────
// Public principal profile (PR-C1)
// ─────────────────────────────────────────────────────────────────────────────
//
// The shape returned by `GET /v1/public/principals/:owner/:principalName`.
// The SPA consumes this for the share-link profile + chat page. The
// owner object is intentionally minimal — just enough to render a
// header avatar; no email or any PII.
//
// `tosRequired` / `tosText` mirror the `instances.tosRequired` /
// `tosText` columns. When `tosRequired` is true, the SPA renders a
// blocking TermsGate before exposing the chat input.
//
// `tags` / `description` are optional in the backend (`description`
// is required for a public profile to be listed, but defensive
// defaults keep the schema tolerant for older rows or test fixtures).
//
// Package vs live-instance note: this endpoint surfaces a *live
// instance* (a running actor on a specific runtime, owned by one
// user). It is NOT a principal *package* (a reusable template that
// can spawn many instances for many users). Future "install this
// template" / "browse packages" features will use a sibling shape —
// keep the `liveInstance` wrapper self-documenting so the two
// concepts don't get conflated by callers.
export const PublicProfile = z.object({
  liveInstance: z.object({
    id: z.string(),
    publicName: z.string(),
    description: z.string().nullable().optional(),
    owner: z.object({
      id: z.string(),
      name: z.string(),
      avatarUrl: z.string().nullable().optional(),
    }),
    capabilities: z.array(z.string()).default([]),
    status: z.enum(['online', 'offline', 'busy', 'error']),
    tosRequired: z.boolean().default(false),
    tosText: z.string().nullable().optional(),
  }),
});
export type PublicProfile = z.infer<typeof PublicProfile>;

// Chat request body for the public chat endpoint
// (POST /v1/public/principals/:owner/:principalName/chat). Mirrors
// the backend's ChatBodySchema — single message plus an optional
// ToS-acknowledged flag (PR-C4: TermsGate persists acks to
// localStorage and re-sends them on subsequent messages).
export const PublicChatBody = z.object({
  message: z.string().min(1),
  tos_acknowledged: z.boolean().optional(),
});
export type PublicChatBody = z.infer<typeof PublicChatBody>;

export const ApiKey = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  createdAt: z.string().datetime(),
  lastUsedAt: z.string().datetime().optional(),
});
export type ApiKey = z.infer<typeof ApiKey>;

// ─────────────────────────────────────────────────────────────────────────────
// Extension Manifest Schema
// ─────────────────────────────────────────────────────────────────────────────

export const ExtensionManifest = z.object({
  // Mirrors the runtime's `validate_agent_name` for extension ids:
  //   1-64 lowercase chars, digits, or "-"
  //   no leading/trailing "-" (so "--" and "-" alone are rejected)
  // The previous `/^[a-z0-9-]+$/` accepted "-" alone and "--" — a
  // path-traversal spelling and a Zod UX regression.
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(
      /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/,
      'Extension ID must be 1-64 lowercase chars, digits, or "-"; no leading/trailing "-"',
    ),
  name: z.string().min(1).max(128),
  version: z.string(),
  extensionType: ExtensionTypeSchema,
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
