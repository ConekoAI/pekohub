import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "../../src/db/schema.js";

export interface TestDb {
  db: ReturnType<typeof drizzle<typeof schema>>;
  client: PGlite;
}

const DDL_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    external_id VARCHAR(256) NOT NULL UNIQUE,
    provider VARCHAR(32) NOT NULL,
    namespace VARCHAR(128) NOT NULL UNIQUE,
    display_name VARCHAR(256),
    email VARCHAR(256),
    avatar_url TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
  );`,

  `CREATE TABLE IF NOT EXISTS api_keys (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(128) NOT NULL,
    prefix VARCHAR(16) NOT NULL,
    hash VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    last_used_at TIMESTAMPTZ
  );`,

  `CREATE TABLE IF NOT EXISTS bundles (
    id SERIAL PRIMARY KEY,
    namespace VARCHAR(128) NOT NULL,
    name VARCHAR(128) NOT NULL,
    bundle_type VARCHAR(32) NOT NULL,
    extension_type VARCHAR(32),
    description TEXT,
    author VARCHAR(256),
    license VARCHAR(64),
    tags JSONB DEFAULT '[]',
    categories JSONB DEFAULT '[]',
    model_providers JSONB DEFAULT '[]',
    required_mcp_servers JSONB DEFAULT '[]',
    homepage TEXT,
    repository TEXT,
    readme TEXT,
    hooks JSONB,
    compatibility JSONB,
    forked_from VARCHAR(256),
    star_count INTEGER DEFAULT 0 NOT NULL,
    pull_count INTEGER DEFAULT 0 NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
  );`,

  `CREATE UNIQUE INDEX IF NOT EXISTS namespace_name_idx ON bundles(namespace, name);`,
  `CREATE INDEX IF NOT EXISTS bundle_type_idx ON bundles(bundle_type);`,
  `CREATE INDEX IF NOT EXISTS search_idx ON bundles(namespace, name, description);`,

  `CREATE TABLE IF NOT EXISTS bundle_versions (
    id SERIAL PRIMARY KEY,
    bundle_id INTEGER NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
    version VARCHAR(64) NOT NULL,
    digest VARCHAR(71) NOT NULL,
    manifest_json JSONB NOT NULL,
    size INTEGER NOT NULL,
    deprecated BOOLEAN DEFAULT FALSE,
    deprecated_message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
  );`,

  `CREATE UNIQUE INDEX IF NOT EXISTS bundle_version_idx ON bundle_versions(bundle_id, version);`,
  `CREATE UNIQUE INDEX IF NOT EXISTS digest_idx ON bundle_versions(digest);`,

  `CREATE TABLE IF NOT EXISTS blobs (
    id SERIAL PRIMARY KEY,
    digest VARCHAR(71) NOT NULL UNIQUE,
    size INTEGER NOT NULL,
    media_type VARCHAR(128),
    storage_key VARCHAR(512) NOT NULL,
    uploaded_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    last_accessed_at TIMESTAMPTZ
  );`,

  `CREATE UNIQUE INDEX IF NOT EXISTS blob_digest_idx ON blobs(digest);`,

  `CREATE TABLE IF NOT EXISTS pull_stats (
    id SERIAL PRIMARY KEY,
    bundle_id INTEGER NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
    version_id INTEGER REFERENCES bundle_versions(id) ON DELETE CASCADE,
    date TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    count INTEGER DEFAULT 1 NOT NULL
  );`,

  `CREATE INDEX IF NOT EXISTS bundle_date_idx ON pull_stats(bundle_id, date);`,

  `CREATE TABLE IF NOT EXISTS audit_logs (
    id SERIAL PRIMARY KEY,
    namespace VARCHAR(128) NOT NULL,
    user_id INTEGER REFERENCES users(id),
    action VARCHAR(64) NOT NULL,
    resource VARCHAR(256) NOT NULL,
    details JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
  );`,

  `CREATE TABLE IF NOT EXISTS refresh_tokens (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_prefix VARCHAR(16) NOT NULL,
    token_hash VARCHAR(256) NOT NULL,
    device_info TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    rotated_from TEXT REFERENCES refresh_tokens(id)
  );`,
  `CREATE INDEX IF NOT EXISTS refresh_tokens_user_active_idx ON refresh_tokens(user_id, revoked_at, expires_at);`,
  `CREATE INDEX IF NOT EXISTS refresh_tokens_prefix_idx ON refresh_tokens(token_prefix);`,

  `CREATE TABLE IF NOT EXISTS instances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type VARCHAR(10) NOT NULL,
    name VARCHAR(255) NOT NULL,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    runtime_id VARCHAR(255) NOT NULL,
    runtime_display_name VARCHAR(255),
    bundle_ref VARCHAR(255),
    status VARCHAR(20) DEFAULT 'offline' NOT NULL,
    exposure VARCHAR(20) DEFAULT 'unexposed' NOT NULL,
    allowed_users JSONB DEFAULT '[]',
    last_seen_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    capabilities JSONB DEFAULT '[]',
    metadata JSONB DEFAULT '{}',
    public_name VARCHAR(255),
    description TEXT,
    tags JSONB DEFAULT '[]',
    category VARCHAR(32),
    tos_required BOOLEAN DEFAULT FALSE,
    tos_text TEXT,
    daily_quota INTEGER,
    weekly_quota INTEGER,
    published_at TIMESTAMPTZ,
    featured BOOLEAN DEFAULT FALSE,
    monetization JSONB DEFAULT '{"enabled":false}'
  );`,
  `CREATE INDEX IF NOT EXISTS idx_instances_owner_id ON instances(owner_id);`,
  `CREATE INDEX IF NOT EXISTS idx_instances_runtime_id ON instances(runtime_id);`,
  `CREATE INDEX IF NOT EXISTS idx_instances_exposure_status ON instances(exposure, status);`,
  `CREATE INDEX IF NOT EXISTS idx_instances_last_seen_at ON instances(last_seen_at);`,
  `CREATE INDEX IF NOT EXISTS idx_instances_published_at ON instances(published_at);`,
  `CREATE INDEX IF NOT EXISTS idx_instances_featured ON instances(featured);`,
  `CREATE INDEX IF NOT EXISTS idx_instances_category ON instances(category);`,

  // Runtimes table (for tunnel owner resolution)
  `CREATE TABLE IF NOT EXISTS runtimes (
    id SERIAL PRIMARY KEY,
    runtime_did VARCHAR(255) NOT NULL UNIQUE,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    display_name VARCHAR(255),
    last_seen_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
  );`,
  `CREATE INDEX IF NOT EXISTS idx_runtimes_runtime_did ON runtimes(runtime_did);`,
];

/**
 * Create a fresh in-memory PostgreSQL database using PGlite.
 * Returns a Drizzle ORM instance connected to it.
 */
export async function createTestDb(): Promise<TestDb> {
  const client = new PGlite();

  const db = drizzle(client, { schema });

  // Create tables one by one (PGlite doesn't support multiple statements)
  for (const ddl of DDL_STATEMENTS) {
    await client.query(ddl);
  }

  return { db, client };
}

/**
 * Truncate all tables to reset data between tests.
 */
export async function resetTables(client: PGlite) {
  const tables = [
    "audit_logs",
    "refresh_tokens",
    "pull_stats",
    "blobs",
    "bundle_versions",
    "bundles",
    "instances",
    "runtimes",
    "api_keys",
    "users",
  ];
  for (const table of tables) {
    await client.query(`DELETE FROM ${table};`);
  }
}
