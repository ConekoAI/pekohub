import { faker } from '@faker-js/faker';
import type { PGlite } from '@electric-sql/pglite';

export interface TestUser {
  id: number;
  externalId: string;
  provider: 'github' | 'google';
  namespace: string;
  displayName: string;
  email: string;
  avatarUrl: string;
}

export interface TestBundle {
  id: number;
  namespace: string;
  name: string;
  bundleType: 'agent' | 'team' | 'extension';
  extensionType?: 'mcp' | 'skill' | 'tool';
  description: string;
  author: string;
  tags: string[];
  starCount: number;
  pullCount: number;
}

export interface TestBundleVersion {
  id: number;
  bundleId: number;
  version: string;
  digest: string;
  manifestJson: Record<string, unknown>;
  size: number;
}

/**
 * Create a test user in the database.
 */
export async function createUser(
  client: PGlite,
  overrides: Partial<TestUser> = {}
): Promise<TestUser> {
  const namespace = overrides.namespace ?? faker.internet.userName().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const provider = overrides.provider ?? 'github';
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
    ]
  );

  return result.rows[0] as TestUser;
}

/**
 * Create a test bundle in the database.
 */
export async function createBundle(
  client: PGlite,
  overrides: Partial<TestBundle> = {}
): Promise<TestBundle> {
  const namespace = overrides.namespace ?? faker.internet.userName().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const name = overrides.name ?? faker.word.noun().toLowerCase();
  const bundleType = overrides.bundleType ?? 'agent';

  const result = await client.query(
    `INSERT INTO bundles (namespace, name, bundle_type, extension_type, description, author, tags, star_count, pull_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, namespace, name, bundle_type, extension_type, description, author, tags, star_count, pull_count`,
    [
      namespace,
      name,
      bundleType,
      overrides.extensionType ?? null,
      overrides.description ?? faker.lorem.sentence(),
      overrides.author ?? faker.person.fullName(),
      JSON.stringify(overrides.tags ?? ['test']),
      overrides.starCount ?? 0,
      overrides.pullCount ?? 0,
    ]
  );

  return result.rows[0] as TestBundle;
}

/**
 * Create a test bundle version in the database.
 */
export async function createBundleVersion(
  client: PGlite,
  bundleId: number,
  overrides: Partial<TestBundleVersion> = {}
): Promise<TestBundleVersion> {
  const version = overrides.version ?? `v${faker.number.int({ min: 1, max: 10 })}.0.0`;
  const digest = overrides.digest ?? `sha256:${faker.string.hexadecimal({ length: 64 }).slice(2)}`;

  const result = await client.query(
    `INSERT INTO bundle_versions (bundle_id, version, digest, manifest_json, size)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, bundle_id, version, digest, manifest_json, size`,
    [
      bundleId,
      version,
      digest,
      JSON.stringify(overrides.manifestJson ?? { schemaVersion: 2, name: 'test-bundle' }),
      overrides.size ?? 1024,
    ]
  );

  return result.rows[0] as TestBundleVersion;
}

/**
 * Create a complete bundle with versions.
 */
export async function createBundleWithVersions(
  client: PGlite,
  versionCount: number = 3,
  overrides: { bundle?: Partial<TestBundle>; versions?: Partial<TestBundleVersion> } = {}
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
