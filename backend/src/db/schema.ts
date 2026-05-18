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
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { BundleTypes, ExtensionTypes } from '@pekohub/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Users & Namespaces
// ─────────────────────────────────────────────────────────────────────────────

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  externalId: varchar('external_id', { length: 256 }).notNull().unique(),
  provider: varchar('provider', { length: 32 }).notNull(), // github, google
  namespace: varchar('namespace', { length: 128 }).notNull().unique(),
  displayName: varchar('display_name', { length: 256 }),
  email: varchar('email', { length: 256 }),
  avatarUrl: text('avatar_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const apiKeys = pgTable('api_keys', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 128 }).notNull(),
  prefix: varchar('prefix', { length: 8 }).notNull(),
  hash: varchar('hash', { length: 64 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
});

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: text('id').primaryKey(),
    userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    tokenPrefix: varchar('token_prefix', { length: 16 }).notNull(),
    tokenHash: varchar('token_hash', { length: 256 }).notNull(),
    deviceInfo: text('device_info'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    rotatedFrom: text('rotated_from').references((): AnyPgColumn => refreshTokens.id),
  },
  (table) => ({
    userActiveIdx: index('refresh_tokens_user_active_idx').on(table.userId, table.revokedAt, table.expiresAt),
    prefixIdx: index('refresh_tokens_prefix_idx').on(table.tokenPrefix),
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// Bundles
// ─────────────────────────────────────────────────────────────────────────────

export const bundles = pgTable(
  'bundles',
  {
    id: serial('id').primaryKey(),
    namespace: varchar('namespace', { length: 128 }).notNull(),
    name: varchar('name', { length: 128 }).notNull(),
    bundleType: varchar('bundle_type', { length: 32 }).notNull().$type<typeof BundleTypes[number]>(),
    extensionType: varchar('extension_type', { length: 32 }).$type<typeof ExtensionTypes[number]>(),
    description: text('description'),
    author: varchar('author', { length: 256 }),
    license: varchar('license', { length: 64 }),
    tags: jsonb('tags').$type<string[]>(),
    categories: jsonb('categories').$type<string[]>(),
    modelProviders: jsonb('model_providers').$type<string[]>(),
    requiredMcpServers: jsonb('required_mcp_servers').$type<string[]>(),
    homepage: text('homepage'),
    repository: text('repository'),
    readme: text('readme'),
    hooks: jsonb('hooks').$type<Array<{ point: string; handler?: string; topicPattern?: string }>>(),
    compatibility: jsonb('compatibility').$type<{ runtime?: string; minVersion?: string; maxVersion?: string }>(),
    forkedFrom: varchar('forked_from', { length: 256 }),
    starCount: integer('star_count').default(0).notNull(),
    pullCount: integer('pull_count').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    namespaceNameIdx: uniqueIndex('namespace_name_idx').on(table.namespace, table.name),
    bundleTypeIdx: index('bundle_type_idx').on(table.bundleType),
    searchIdx: index('search_idx').on(table.namespace, table.name, table.description),
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// Bundle Versions
// ─────────────────────────────────────────────────────────────────────────────

export const bundleVersions = pgTable(
  'bundle_versions',
  {
    id: serial('id').primaryKey(),
    bundleId: integer('bundle_id').notNull().references(() => bundles.id, { onDelete: 'cascade' }),
    version: varchar('version', { length: 64 }).notNull(),
    digest: varchar('digest', { length: 71 }).notNull(), // sha256:hex64
    manifestJson: jsonb('manifest_json').notNull(),
    size: integer('size').notNull(),
    deprecated: boolean('deprecated').default(false),
    deprecatedMessage: text('deprecated_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    bundleVersionIdx: uniqueIndex('bundle_version_idx').on(table.bundleId, table.version),
    digestIdx: uniqueIndex('digest_idx').on(table.digest),
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// Blobs (content-addressable storage)
// ─────────────────────────────────────────────────────────────────────────────

export const blobs = pgTable(
  'blobs',
  {
    id: serial('id').primaryKey(),
    digest: varchar('digest', { length: 71 }).notNull().unique(),
    size: integer('size').notNull(),
    mediaType: varchar('media_type', { length: 128 }),
    storageKey: varchar('storage_key', { length: 512 }).notNull(),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).defaultNow().notNull(),
    lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true }),
  },
  (table) => ({
    digestIdx: uniqueIndex('blob_digest_idx').on(table.digest),
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// Pull Statistics
// ─────────────────────────────────────────────────────────────────────────────

export const pullStats = pgTable(
  'pull_stats',
  {
    id: serial('id').primaryKey(),
    bundleId: integer('bundle_id').notNull().references(() => bundles.id, { onDelete: 'cascade' }),
    versionId: integer('version_id').references(() => bundleVersions.id, { onDelete: 'cascade' }),
    date: timestamp('date', { withTimezone: true }).defaultNow().notNull(),
    count: integer('count').default(1).notNull(),
  },
  (table) => ({
    bundleDateIdx: index('bundle_date_idx').on(table.bundleId, table.date),
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// Audit Log
// ─────────────────────────────────────────────────────────────────────────────

export const auditLogs = pgTable('audit_logs', {
  id: serial('id').primaryKey(),
  namespace: varchar('namespace', { length: 128 }).notNull(),
  userId: integer('user_id').references(() => users.id),
  action: varchar('action', { length: 64 }).notNull(), // push, pull, delete, permission_change
  resource: varchar('resource', { length: 256 }).notNull(),
  details: jsonb('details'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
