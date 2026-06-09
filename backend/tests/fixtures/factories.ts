import { faker } from "@faker-js/faker";
import type { PGlite } from "@electric-sql/pglite";

export interface TestUser {
  id: number;
  externalId: string;
  provider: "github" | "google";
  namespace: string;
  displayName: string;
  email: string;
  avatarUrl: string;
}

export interface TestBundle {
  id: number;
  namespace: string;
  name: string;
  bundleType: "agent" | "team" | "extension";
  extensionType?:
    | "mcp"
    | "skill"
    | "tool"
    | "gateway"
    | "universal"
    | "general"
    | "team";
  description: string;
  author: string;
  tags: string[];
  starCount: number;
  pullCount: number;
  hooks?: Array<{ point: string; handler?: string; topicPattern?: string }>;
  compatibility?: {
    runtime?: string;
    minVersion?: string;
    maxVersion?: string;
  };
}

export interface TestBundleVersion {
  id: number;
  bundleId: number;
  version: string;
  digest: string;
  manifestJson: Record<string, unknown>;
  size: number;
}

export interface TestInstance {
  id: string;
  type: "agent" | "team";
  name: string;
  ownerId: number;
  runtimeId: string;
  runtimeDisplayName: string | null;
  bundleRef: string | null;
  status: "online" | "offline" | "busy" | "error";
  exposure: "private" | "public" | "unexposed";
  allowedUsers: string[];
  lastSeenAt: Date | null;
  createdAt: Date;
  capabilities: string[];
  metadata: Record<string, unknown>;
  publicName: string | null;
  description: string | null;
  tags: string[];
  category: string | null;
  tosRequired: boolean;
  tosText: string | null;
  dailyQuota: number | null;
  weeklyQuota: number | null;
  publishedAt: Date | null;
  featured: boolean;
}

/**
 * Create a test user in the database.
 */
export async function createUser(
  client: PGlite,
  overrides: Partial<TestUser> = {},
): Promise<TestUser> {
  const namespace =
    overrides.namespace ??
    faker.internet
      .userName()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "");
  const provider = overrides.provider ?? "github";
  const externalId = `${provider}:${overrides.id ?? faker.number.int({ min: 100000, max: 999999 })}`;

  const result = await client.query(
    `INSERT INTO users (external_id, provider, namespace, display_name, email, avatar_url)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, external_id, provider, namespace, display_name, email, avatar_url`,
    [
      externalId,
      provider,
      namespace,
      overrides.displayName ?? faker.person.fullName(),
      overrides.email ?? faker.internet.email(),
      overrides.avatarUrl ?? faker.image.avatar(),
    ],
  );

  return result.rows[0] as TestUser;
}

/**
 * Create a test bundle in the database.
 */
export async function createBundle(
  client: PGlite,
  overrides: Partial<TestBundle> = {},
): Promise<TestBundle> {
  const namespace =
    overrides.namespace ??
    faker.internet
      .userName()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "");
  const name = overrides.name ?? faker.word.noun().toLowerCase();
  const bundleType = overrides.bundleType ?? "agent";

  const result = await client.query(
    `INSERT INTO bundles (namespace, name, bundle_type, extension_type, description, author, tags, hooks, compatibility, star_count, pull_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id, namespace, name, bundle_type, extension_type, description, author, tags, hooks, compatibility, star_count, pull_count`,
    [
      namespace,
      name,
      bundleType,
      overrides.extensionType ?? null,
      overrides.description ?? faker.lorem.sentence(),
      overrides.author ?? faker.person.fullName(),
      JSON.stringify(overrides.tags ?? ["test"]),
      JSON.stringify(overrides.hooks ?? null),
      JSON.stringify(overrides.compatibility ?? null),
      overrides.starCount ?? 0,
      overrides.pullCount ?? 0,
    ],
  );

  return result.rows[0] as TestBundle;
}

/**
 * Create a test bundle version in the database.
 */
export async function createBundleVersion(
  client: PGlite,
  bundleId: number,
  overrides: Partial<TestBundleVersion> = {},
): Promise<TestBundleVersion> {
  const version =
    overrides.version ?? `v${faker.number.int({ min: 1, max: 10 })}.0.0`;
  const digest =
    overrides.digest ??
    `sha256:${faker.string.hexadecimal({ length: 64 }).slice(2)}`;

  const result = await client.query(
    `INSERT INTO bundle_versions (bundle_id, version, digest, manifest_json, size)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, bundle_id, version, digest, manifest_json, size`,
    [
      bundleId,
      version,
      digest,
      JSON.stringify(
        overrides.manifestJson ?? { schemaVersion: 2, name: "test-bundle" },
      ),
      overrides.size ?? 1024,
    ],
  );

  return result.rows[0] as TestBundleVersion;
}

/**
 * Create a complete bundle with versions.
 */
export async function createBundleWithVersions(
  client: PGlite,
  versionCount: number = 3,
  overrides: {
    bundle?: Partial<TestBundle>;
    versions?: Partial<TestBundleVersion>;
  } = {},
): Promise<{ bundle: TestBundle; versions: TestBundleVersion[] }> {
  const bundle = await createBundle(client, overrides.bundle);
  const versions: TestBundleVersion[] = [];

  for (let i = 0; i < versionCount; i++) {
    const version = await createBundleVersion(client, bundle.id, {
      version: `v${i + 1}.0.0`,
      ...overrides.versions,
    });
    versions.push(version);
  }

  return { bundle, versions };
}

/**
 * Create a test instance in the database.
 */
export async function createInstance(
  client: PGlite,
  overrides: Partial<TestInstance> & { ownerId: number },
): Promise<TestInstance> {
  const id = overrides.id ?? crypto.randomUUID();
  const type = overrides.type ?? "agent";
  const name = overrides.name ?? faker.word.noun().toLowerCase();
  const runtimeId =
    overrides.runtimeId ?? `runtime-${faker.string.alphanumeric(8)}`;

  const result = await client.query(
    `INSERT INTO instances (
      id, type, name, owner_id, runtime_id, runtime_display_name, bundle_ref,
      status, exposure, allowed_users, capabilities, metadata,
      public_name, description, tags, category, tos_required, tos_text,
      daily_quota, weekly_quota, published_at, featured
    )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
     RETURNING id, type, name, owner_id, runtime_id, runtime_display_name, bundle_ref,
       status, exposure, allowed_users, last_seen_at, created_at, capabilities, metadata,
       public_name, description, tags, category, tos_required, tos_text,
       daily_quota, weekly_quota, published_at, featured`,
    [
      id,
      type,
      name,
      overrides.ownerId,
      runtimeId,
      overrides.runtimeDisplayName ?? null,
      overrides.bundleRef ?? null,
      overrides.status ?? "offline",
      overrides.exposure ?? "unexposed",
      JSON.stringify(overrides.allowedUsers ?? []),
      JSON.stringify(overrides.capabilities ?? []),
      JSON.stringify(overrides.metadata ?? {}),
      overrides.publicName ?? null,
      overrides.description ?? null,
      JSON.stringify(overrides.tags ?? []),
      overrides.category ?? null,
      overrides.tosRequired ?? false,
      overrides.tosText ?? null,
      overrides.dailyQuota ?? null,
      overrides.weeklyQuota ?? null,
      overrides.publishedAt ?? null,
      overrides.featured ?? false,
    ],
  );

  const row = result.rows[0];
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    ownerId: row.owner_id,
    runtimeId: row.runtime_id,
    runtimeDisplayName: row.runtime_display_name,
    bundleRef: row.bundle_ref,
    status: row.status,
    exposure: row.exposure,
    allowedUsers: row.allowed_users ?? [],
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    capabilities: row.capabilities ?? [],
    metadata: row.metadata ?? {},
    publicName: row.public_name ?? null,
    description: row.description ?? null,
    tags: row.tags ?? [],
    category: row.category ?? null,
    tosRequired: row.tos_required ?? false,
    tosText: row.tos_text ?? null,
    dailyQuota: row.daily_quota ?? null,
    weeklyQuota: row.weekly_quota ?? null,
    publishedAt: row.published_at ?? null,
    featured: row.featured ?? false,
  } as TestInstance;
}
