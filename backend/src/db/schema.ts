import {
  pgTable,
  serial,
  varchar,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  uniqueIndex,
  index,
  uuid,
} from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import {
  BundleTypes,
  type Subject,
} from "@pekohub/shared";

// ─────────────────────────────────────────────────────────────────────────────
// Users & Namespaces
// ─────────────────────────────────────────────────────────────────────────────

export const users = pgTable("users", {
  // Post-H3: native UUID column. The runtime always emits `user.id`
  // as a string (JWT `sub`, `x-pekohub-user-id` header), so the
  // integer round-trip was a coercion hazard. The DB-side default
  // `gen_random_uuid()` is set in migration 0011; Drizzle's `uuid()`
  // column doesn't carry a server-side default, so inserts must
  // pass an explicit id (or rely on the pg default).
  id: uuid("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  externalId: varchar("external_id", { length: 256 }).notNull().unique(),
  provider: varchar("provider", { length: 32 }).notNull(), // github, google
  namespace: varchar("namespace", { length: 128 }).notNull().unique(),
  displayName: varchar("display_name", { length: 256 }),
  email: varchar("email", { length: 256 }),
  avatarUrl: text("avatar_url"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const apiKeys = pgTable("api_keys", {
  id: serial("id").primaryKey(),
  // Post-H3: FK is uuid to match users.id (was integer).
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 128 }).notNull(),
  prefix: varchar("prefix", { length: 16 }).notNull(),
  hash: varchar("hash", { length: 64 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
});

export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: text("id").primaryKey(),
    // Post-H3: FK is uuid to match users.id (was integer).
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenPrefix: varchar("token_prefix", { length: 16 }).notNull(),
    tokenHash: varchar("token_hash", { length: 256 }).notNull(),
    deviceInfo: text("device_info"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    rotatedFrom: text("rotated_from").references(
      (): AnyPgColumn => refreshTokens.id,
    ),
  },
  (table) => ({
    userActiveIdx: index("refresh_tokens_user_active_idx").on(
      table.userId,
      table.revokedAt,
      table.expiresAt,
    ),
    prefixIdx: index("refresh_tokens_prefix_idx").on(table.tokenPrefix),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Bundles (templates)
//
// One row per registry repository. The hub is template-only: a row is a
// pushed *template* — a stripped `principal.toml` carried as a
// zero-layer OCI manifest (peko-runtime ADR-056 D6) — never an
// existence and never a capability package.
//
// Removed by the template-only cut (ADR-005 realignment): the
// extension-era package metadata `extension_type`, `categories`,
// `model_providers`, `required_mcp_servers`, `hooks`, `compatibility`,
// and the fork lineage `forked_from`. Capabilities became workspace
// files (runtime ADR-047 §5 / ADR-050) and the `.agent`/`.ext` package
// formats were retired (ADR-037), so none of it has a producer.
// ─────────────────────────────────────────────────────────────────────────────

export const bundles = pgTable(
  "bundles",
  {
    id: serial("id").primaryKey(),
    namespace: varchar("namespace", { length: 128 }).notNull(),
    name: varchar("name", { length: 128 }).notNull(),
    // `principal` is the only member of BundleTypes (see constants.ts).
    bundleType: varchar("bundle_type", { length: 32 })
      .notNull()
      .$type<(typeof BundleTypes)[number]>(),
    // Publisher ownership (ADR-056). The account that first pushed this
    // bundle owns it: only the publisher may push new versions,
    // deprecate, or delete. Nullable because rows predating this
    // column have no recorded publisher — such legacy rows can be
    // claimed by the caller whose `users.namespace` matches
    // `bundles.namespace` (the pre-publisher ownership rule).
    publisherId: uuid("publisher_id").references(() => users.id, {
      onDelete: "set null",
    }),
    description: text("description"),
    author: varchar("author", { length: 256 }),
    license: varchar("license", { length: 64 }),
    tags: jsonb("tags").$type<string[]>(),
    homepage: text("homepage"),
    repository: text("repository"),
    readme: text("readme"),
    pullCount: integer("pull_count").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    namespaceNameIdx: uniqueIndex("namespace_name_idx").on(
      table.namespace,
      table.name,
    ),
    bundleTypeIdx: index("bundle_type_idx").on(table.bundleType),
    searchIdx: index("search_idx").on(
      table.namespace,
      table.name,
      table.description,
    ),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Bundle Versions
// ─────────────────────────────────────────────────────────────────────────────

export const bundleVersions = pgTable(
  "bundle_versions",
  {
    id: serial("id").primaryKey(),
    bundleId: integer("bundle_id")
      .notNull()
      .references(() => bundles.id, { onDelete: "cascade" }),
    version: varchar("version", { length: 64 }).notNull(),
    digest: varchar("digest", { length: 71 }).notNull(), // sha256:hex64
    manifestJson: jsonb("manifest_json").notNull(),
    size: integer("size").notNull(),
    deprecated: boolean("deprecated").default(false),
    deprecatedMessage: text("deprecated_message"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    bundleVersionIdx: uniqueIndex("bundle_version_idx").on(
      table.bundleId,
      table.version,
    ),
    digestIdx: uniqueIndex("digest_idx").on(table.digest),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Blobs (content-addressable storage)
// ─────────────────────────────────────────────────────────────────────────────

export const blobs = pgTable(
  "blobs",
  {
    id: serial("id").primaryKey(),
    digest: varchar("digest", { length: 71 }).notNull().unique(),
    size: integer("size").notNull(),
    mediaType: varchar("media_type", { length: 128 }),
    storageKey: varchar("storage_key", { length: 512 }).notNull(),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }),
  },
  (table) => ({
    digestIdx: uniqueIndex("blob_digest_idx").on(table.digest),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Pull Statistics
// ─────────────────────────────────────────────────────────────────────────────

export const pullStats = pgTable(
  "pull_stats",
  {
    id: serial("id").primaryKey(),
    bundleId: integer("bundle_id")
      .notNull()
      .references(() => bundles.id, { onDelete: "cascade" }),
    versionId: integer("version_id").references(() => bundleVersions.id, {
      onDelete: "cascade",
    }),
    date: timestamp("date", { withTimezone: true }).defaultNow().notNull(),
    count: integer("count").default(1).notNull(),
  },
  (table) => ({
    bundleDateIdx: uniqueIndex("bundle_date_idx").on(table.bundleId, table.date),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Instances (Remote Instance Management)
// ─────────────────────────────────────────────────────────────────────────────

export const instances = pgTable(
  "instances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: varchar("type", { length: 16 }).notNull(), // 'principal' (post-ADR-041)
    name: varchar("name", { length: 255 }).notNull(),
    // Typed owner per ADR-041 / peko-runtime's `Subject` enum. This
    // is the source of truth for "who owns this instance" — the
    // pre-ADR-041 integer `owner_id` column was dropped in migration
    // 0010 (H1). Nullable so a row may exist without a declared owner
    // (the empty-sentinel `Subject::User("")` is treated the same way;
    // see `EMPTY_OWNER_SUBJECT` in @pekohub/shared).
    ownerSubject: jsonb("owner_subject").$type<Subject | null>(),
    runtimeId: varchar("runtime_id", { length: 255 }).notNull(),
    runtimeDisplayName: varchar("runtime_display_name", { length: 255 }),
    bundleRef: varchar("bundle_ref", { length: 255 }),
    status: varchar("status", { length: 20 }).notNull().default("offline"),
    exposure: varchar("exposure", { length: 20 })
      .notNull()
      .default("unexposed"),
    // Post-H4: the typed `allowed_principals` JSONB column is gone.
    // The runtime's `PrincipalConfig.permissions` is the canonical
    // ACL surface (R4); pekohub only knows public vs private exposure.
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    capabilities: jsonb("capabilities").default("[]"),
    metadata: jsonb("metadata").default("{}"),

    // Public profile fields (ADR-003)
    publicName: varchar("public_name", { length: 255 }),
    description: text("description"),
    tags: jsonb("tags").default("[]"),
    category: varchar("category", { length: 32 }),
    tosRequired: boolean("tos_required").default(false),
    tosText: text("tos_text"),
    dailyQuota: integer("daily_quota"),
    weeklyQuota: integer("weekly_quota"),

    // Discovery & curation
    publishedAt: timestamp("published_at", { withTimezone: true }),
    featured: boolean("featured").default(false),

    // Monetization hooks (future)
    monetization: jsonb("monetization").default('{"enabled":false}'),

    // ADR-041: per-Principal DID, the key the cross-runtime
    // `principal_send` resolver uses to look up a host via
    // `/v1/principals/by-did/:did`. Set by the runtime on
    // `instance_announce`. Nullable so pre-#82 runtimes and
    // migrations keep working; the by-did endpoint simply 404s when
    // the column is null. The runtime emits
    // `did:peko:principal:<keyhash>` post-#82. Post-ADR-056-D7 the
    // column is indexed but NOT unique — see the index note below.
    principalDid: varchar("principal_did", { length: 512 }),
    // ADR-058 D4: true only when the announcing runtime proved
    // possession of the principal DID's key via `principalPop`
    // (did:key principals). Legacy (non-did:key) ids and all rows
    // predating this column default to false — the directory
    // consumer can treat unverified DIDs as hints, not identity.
    principalDidVerified: boolean("principal_did_verified")
      .default(false)
      .notNull(),
  },
  (table) => ({
    runtimeIdIdx: index("idx_instances_runtime_id").on(table.runtimeId),
    exposureStatusIdx: index("idx_instances_exposure_status").on(
      table.exposure,
      table.status,
    ),
    lastSeenAtIdx: index("idx_instances_last_seen_at").on(table.lastSeenAt),
    publishedAtIdx: index("idx_instances_published_at").on(table.publishedAt),
    featuredIdx: index("idx_instances_featured").on(table.featured),
    categoryIdx: index("idx_instances_category").on(table.category),
    // ADR-041: B-tree on `principal_did` so the by-did resolver is an
    // indexed lookup. Post-ADR-056-D7 this is deliberately NOT unique:
    // a cryogenic-transported principal lands on a new runtime with the
    // SAME DID and a new instance id, so multiple rows may carry one
    // DID. Singularity is enforced at the exposure layer instead —
    // see `InstanceService.findPublicExposureConflict` (at most one
    // publicly exposed instance per DID network-wide).
    principalDidIdx: index("idx_instances_principal_did").on(
      table.principalDid,
    ),
  }),
);

export const instanceRelations = relations(instances, ({ one }) => ({
  // Owner lookup routes through `instances.owner_subject` (JSONB)
  // post-H1; the legacy `instances.owner_id` integer FK is gone, so
  // no Drizzle relation ships for it. Callers join via
  // `users.id::text = instances.owner_subject->>'id'` (text-text
  // comparison; both sides are string after H3) where the typed
  // owner is a user.
}));

// ─────────────────────────────────────────────────────────────────────────────
// Runtimes
// ─────────────────────────────────────────────────────────────────────────────

export const runtimes = pgTable(
  "runtimes",
  {
    id: serial("id").primaryKey(),
    runtimeDid: varchar("runtime_did", { length: 255 }).notNull().unique(),
    // Post-H3: FK is uuid to match users.id (was integer).
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    displayName: varchar("display_name", { length: 255 }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    runtimeDidIdx: index("idx_runtimes_runtime_did").on(table.runtimeDid),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Audit Log
// ─────────────────────────────────────────────────────────────────────────────

export const auditLogs = pgTable("audit_logs", {
  id: serial("id").primaryKey(),
  namespace: varchar("namespace", { length: 128 }).notNull(),
  userId: uuid("user_id").references(() => users.id),
  action: varchar("action", { length: 64 }).notNull(), // push, pull, delete, permission_change
  resource: varchar("resource", { length: 256 }).notNull(),
  details: jsonb("details"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
