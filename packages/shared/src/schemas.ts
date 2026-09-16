import { z } from 'zod';
import { BundleTypes } from './constants.js';

// ─────────────────────────────────────────────────────────────────────────────
// Template registry schemas
//
// PekoHub's registry is **template-only** (peko-runtime ADR-056 D6): a
// push carries a stripped `principal.toml` — DNA — and never an
// existence, a key, or a capability package.
//
// Deliberately absent, and not to be reintroduced:
//   - `extensionType` / `ExtensionManifest` / `HookPoint`: the extension
//     framework (runtime ADR-017/024/036) was superseded by plain
//     workspace files (ADR-047 §5) and its registry surface deleted
//     (ADR-050). Capabilities are files; presence = visibility.
//   - `modelProviders` / `requiredMcpServers` / `categories`: package
//     metadata for authoring agent/extension bundles, retired with the
//     `.agent`/`.ext` formats (ADR-037).
//   - `hooks` / `compatibility`: an extension's hook bindings and the
//     runtime version matrix it targeted. Templates declare neither.
//   - `forkedFrom`: forking a template is meaningless — DNA is
//     re-pushed from a workspace, not copied out of the registry.
// ─────────────────────────────────────────────────────────────────────────────

const nullishToUndefined = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((val) => (val === null ? undefined : val), schema);

// ─────────────────────────────────────────────────────────────────────────────
// Template metadata (Pekohub-specific metadata embedded in OCI manifest)
// ─────────────────────────────────────────────────────────────────────────────

export const BundleMetadata = z.object({
  name: z.string().min(1).max(128),
  description: z.string().max(2000).optional(),
  author: z.string().min(1).max(256),
  license: z.string().max(64).optional().nullable(),
  tags: nullishToUndefined(z.array(z.string().max(32)).max(20).optional()),
  /**
   * Wire value for the artifact kind. `principal` is the only member of
   * `BundleTypes` — the runtime's push path hard-codes it (peko-runtime
   * `peko-rs/core/src/registry/client.rs`) and the UI calls the artifact
   * a template.
   */
  bundleType: z.enum(BundleTypes),
  homepage: z.string().url().optional().nullable(),
  repository: z.string().url().optional().nullable(),
  readme: z.string().max(50000).optional().nullable(),
  version: z
    .string()
    .regex(
      /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/,
      'Invalid semantic version',
    )
    .or(z.literal('latest'))
    .or(z.literal('')),
  deprecated: z.boolean().optional(),
  deprecatedMessage: z.string().optional().nullable(),
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
      // Only `principal` exists, so this filter is a guard rather than a
      // selector: it lets the SPA assert "templates only" at the query
      // layer even if a legacy row is still indexed.
      bundleType: z.enum(BundleTypes).optional(),
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
  tags: nullishToUndefined(z.array(z.string()).optional()),
  pullCount: z.number().int().nonnegative(),
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
  /**
   * `peko pull <host>/<repo>:<tag>` — the pull half of the flow. The
   * pulled artifact is a bare `.template.toml`, so grinding it is a
   * second step: `peko create <name> -f <file>` (ADR-056 D6).
   */
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
// Public peko profile (PR-C1)
// ─────────────────────────────────────────────────────────────────────────────
//
// The shape returned by `GET /v1/public/pekos/:owner/:pekoName`
// (renamed from `/v1/public/principals/...` in the ADR-005
// realignment).
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
// user). It is NOT a template — a template is DNA that spawns a fresh
// identity, never a live actor. Keep the `liveInstance` wrapper
// self-documenting so the two concepts don't get conflated by callers.
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
// (POST /v1/public/pekos/:owner/:pekoName/chat). Mirrors
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
