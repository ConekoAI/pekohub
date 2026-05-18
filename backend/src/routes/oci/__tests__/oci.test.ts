import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import crypto from 'node:crypto';

// Set NODE_ENV=development BEFORE importing routes (so process.env check in manifests.ts picks it up)
process.env.NODE_ENV = 'development';

// ── Helpers ──────────────────────────────────────────────────────────────────

function sha256(buffer: Buffer | string): string {
  return 'sha256:' + crypto.createHash('sha256').update(buffer).digest('hex');
}

// ── Test setup (must be synchronous for vi.mock hoisting) ────────────────────

const mockDbQueries = {
  bundles: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
  },
  bundleVersions: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
  },
  blobs: {
    findFirst: vi.fn(),
  },
};

const mockDbInsert = vi.fn();
const mockDbUpdate = vi.fn();

// Reset function to clear all mocks between tests
export function resetMocks() {
  mockDbQueries.bundles.findFirst.mockReset();
  mockDbQueries.bundles.findMany.mockReset();
  mockDbQueries.bundleVersions.findFirst.mockReset();
  mockDbQueries.bundleVersions.findMany.mockReset();
  mockDbQueries.blobs.findFirst.mockReset();
  mockDbInsert.mockClear();
  mockDbUpdate.mockClear();
}

vi.mock('../../../db/index.js', () => ({
  db: {
    query: mockDbQueries,
    insert: mockDbInsert.mockReturnValue({
      values: vi.fn().mockReturnThis(),
      returning: vi.fn(),
      onConflictDoUpdate: vi.fn().mockReturnThis(),
    }),
    update: mockDbUpdate.mockReturnValue({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
    }),
  },
}));

// Import routes after mocking db
const { default: ociRoutes } = await import('../index.js');

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 10 * 1024 * 1024 });

  // Content-type parsers required by OCI routes
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });
  app.addContentTypeParser('application/vnd.oci.image.manifest.v1+json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });
  app.addContentTypeParser('application/vnd.oci.image.index.v1+json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  // Mock config
  app.decorate('config', {
    PORT: '3000',
    HOST: '0.0.0.0',
    NODE_ENV: 'development',
    DATABASE_URL: 'postgres://test',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_REGION: 'us-east-1',
    S3_ACCESS_KEY: 'test',
    S3_SECRET_KEY: 'test',
    S3_BUCKET: 'test',
    S3_FORCE_PATH_STYLE: 'true',
    MEILISEARCH_URL: 'http://localhost:7700',
    MEILISEARCH_API_KEY: 'test',
    JWT_SECRET: 'test-secret-must-be-at-least-32-characters-long',
    REGISTRY_BASE_URL: 'http://localhost:3000',
    ALLOW_DEV_AUTH_BYPASS: 'true',
    RATE_LIMIT_MAX: 100,
    RATE_LIMIT_WINDOW_MS: 60000,
    GC_ENABLED: 'true',
    GC_INTERVAL_MS: 86400000,
    GC_RETENTION_DAYS: 7,
    GC_BATCH_SIZE: 1000,
  });

  // Mock storage
  const storageMap = new Map<string, Buffer>();
  app.decorate('storage', {
    put: async (key: string, body: Buffer) => { storageMap.set(key, body); },
    get: async (key: string) => storageMap.get(key) ?? Buffer.from([]),
    exists: async (key: string) => storageMap.has(key),
    delete: async (key: string) => { storageMap.delete(key); },
    getSignedGetUrl: async () => 'http://signed',
    getSignedPutUrl: async () => 'http://signed',
  });

  // Mock search
  app.decorate('search', {
    indexBundle: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue({ hits: [], total: 0, page: 1, perPage: 20 }),
    deleteBundle: vi.fn().mockResolvedValue(undefined),
  });

  // Mock auth — throws in test mode so manifest PUT falls back to dev mode (NODE_ENV=development)
  app.decorate('authenticate', vi.fn().mockRejectedValue(new Error('No auth')));

  await app.register(ociRoutes);
  await app.ready();
  return app;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('OCI Distribution Spec Routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    resetMocks();
  });

  // ── Catalog ────────────────────────────────────────────────────────────────

  describe('GET /v2/_catalog', () => {
    it('returns an empty repository list when no bundles exist', async () => {
      mockDbQueries.bundles.findMany.mockResolvedValue([]);

      const res = await app.inject({ method: 'GET', url: '/v2/_catalog' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('repositories');
      expect(body.repositories).toEqual([]);
    });

    it('returns repositories in mock order', async () => {
      mockDbQueries.bundles.findMany.mockResolvedValue([
        { namespace: 'acme', name: 'alpha' },
        { namespace: 'acme', name: 'beta' },
        { namespace: 'zoo', name: 'zebra' },
      ]);

      const res = await app.inject({ method: 'GET', url: '/v2/_catalog' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.repositories).toEqual(['acme/alpha', 'acme/beta', 'zoo/zebra']);
    });

    it('supports pagination with n and last', async () => {
      mockDbQueries.bundles.findMany.mockResolvedValue([
        { namespace: 'a', name: 'a1' },
        { namespace: 'b', name: 'b1' },
        { namespace: 'c', name: 'c1' },
      ]);

      // last='a/a1' finds first repo > 'a/a1' = 'b/b1' at index 1, startIdx=2, slice(2,3)=['c/c1']
      const res = await app.inject({ method: 'GET', url: '/v2/_catalog?n=1&last=a/a1' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.repositories).toEqual(['c/c1']);
    });
  });

  // ── Tags ───────────────────────────────────────────────────────────────────

  describe('GET /v2/:namespace/:name/tags/list', () => {
    it('returns 404 when bundle does not exist', async () => {
      mockDbQueries.bundles.findFirst.mockResolvedValue(undefined);

      const res = await app.inject({ method: 'GET', url: '/v2/ns/name/tags/list' });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.errors[0].code).toBe('NAME_UNKNOWN');
    });

    it('returns tags for an existing bundle', async () => {
      mockDbQueries.bundles.findFirst.mockResolvedValue({ id: 1, namespace: 'ns', name: 'name' });
      mockDbQueries.bundleVersions.findMany.mockResolvedValue([
        { version: 'v1.0.0' },
        { version: 'v1.1.0' },
      ]);

      const res = await app.inject({ method: 'GET', url: '/v2/ns/name/tags/list' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.name).toBe('ns/name');
      expect(body.tags).toEqual(['v1.0.0', 'v1.1.0']);
    });

    it('paginates tags with last and n', async () => {
      mockDbQueries.bundles.findFirst.mockResolvedValue({ id: 1, namespace: 'ns', name: 'name' });
      mockDbQueries.bundleVersions.findMany.mockResolvedValue([
        { version: 'v1.0.0' },
        { version: 'v1.1.0' },
        { version: 'v2.0.0' },
      ]);

      const res = await app.inject({ method: 'GET', url: '/v2/ns/name/tags/list?n=1&last=v1.0.0' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.tags).toEqual(['v1.1.0']);
    });
  });

  // ── Blobs HEAD / GET ───────────────────────────────────────────────────────

  describe('HEAD /v2/:namespace/:name/blobs/:digest', () => {
    it('returns 404 for unknown blob', async () => {
      mockDbQueries.blobs.findFirst.mockResolvedValue(undefined);

      const res = await app.inject({ method: 'HEAD', url: '/v2/ns/name/blobs/sha256:abcd' });
      expect(res.statusCode).toBe(404);
    });

    it('returns headers for an existing blob', async () => {
      mockDbQueries.blobs.findFirst.mockResolvedValue({
        digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        size: 42,
        mediaType: 'application/tar+gzip',
      });

      const res = await app.inject({
        method: 'HEAD',
        url: '/v2/ns/name/blobs/sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['docker-content-digest']).toBe(
        'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      );
      expect(res.headers['content-length']).toBe('42');
    });
  });

  describe('GET /v2/:namespace/:name/blobs/:digest', () => {
    it('returns 404 for unknown blob', async () => {
      mockDbQueries.blobs.findFirst.mockResolvedValue(undefined);

      const res = await app.inject({ method: 'GET', url: '/v2/ns/name/blobs/sha256:abcd' });
      expect(res.statusCode).toBe(404);
    });

    it('returns blob data with correct headers', async () => {
      const digest = sha256('hello world');
      mockDbQueries.blobs.findFirst.mockResolvedValue({
        digest,
        size: 11,
        mediaType: 'application/octet-stream',
        storageKey: `blobs/${digest}`,
      });
      mockDbQueries.bundles.findFirst.mockResolvedValue({ id: 1 });

      // Pre-seed storage
      await app.storage.put(`blobs/${digest}`, Buffer.from('hello world'));

      const res = await app.inject({ method: 'GET', url: `/v2/ns/name/blobs/${digest}` });
      expect(res.statusCode).toBe(200);
      expect(res.headers['docker-content-digest']).toBe(digest);
      expect(res.headers['content-type']).toBe('application/octet-stream');
      expect(res.body).toBe('hello world');
    });
  });

  // ── Blob Upload ────────────────────────────────────────────────────────────

  describe('POST /v2/:namespace/:name/blobs/uploads/', () => {
    it('initiates an upload with 202 and Location header', async () => {
      const res = await app.inject({ method: 'POST', url: '/v2/ns/name/blobs/uploads/' });
      expect(res.statusCode).toBe(202);
      expect(res.headers.location).toMatch(/^\/v2\/ns\/name\/blobs\/uploads\/[\w-]+$/);
      expect(res.headers.range).toBe('0-0');
    });
  });

  describe('PUT /v2/:namespace/:name/blobs/uploads/:uuid', () => {
    it('rejects upload without digest query param', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/v2/ns/name/blobs/uploads/123e4567-e89b-12d3-a456-426614174000',
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.errors[0].code).toBe('DIGEST_INVALID');
    });

    it('rejects upload when digest does not match body', async () => {
      const badDigest = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
      const res = await app.inject({
        method: 'PUT',
        url: `/v2/ns/name/blobs/uploads/123e4567-e89b-12d3-a456-426614174000?digest=${badDigest}`,
        headers: { 'content-type': 'application/octet-stream' },
        payload: Buffer.from('not matching'),
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.errors[0].code).toBe('DIGEST_INVALID');
    });

    it('accepts monolithic upload and stores blob', async () => {
      const payload = Buffer.from('monolithic blob');
      const digest = sha256(payload);
      mockDbQueries.blobs.findFirst.mockResolvedValue(undefined);

      const res = await app.inject({
        method: 'PUT',
        url: `/v2/ns/name/blobs/uploads/123e4567-e89b-12d3-a456-426614174000?digest=${digest}`,
        headers: { 'content-type': 'application/octet-stream' },
        payload,
      });
      expect(res.statusCode).toBe(201);
      expect(res.headers['docker-content-digest']).toBe(digest);
      expect(res.headers.location).toBe(`/v2/ns/name/blobs/${digest}`);

      // Verify db insert was called
      expect(mockDbInsert).toHaveBeenCalled();
    });

    it('returns 201 without re-storing when blob already exists', async () => {
      const payload = Buffer.from('dedup blob');
      const digest = sha256(payload);
      mockDbQueries.blobs.findFirst.mockResolvedValue({ digest, size: payload.length });

      const res = await app.inject({
        method: 'PUT',
        url: `/v2/ns/name/blobs/uploads/123e4567-e89b-12d3-a456-426614174000?digest=${digest}`,
        headers: { 'content-type': 'application/octet-stream' },
        payload,
      });
      expect(res.statusCode).toBe(201);
      expect(res.headers['docker-content-digest']).toBe(digest);
    });
  });

  // ── Manifests ──────────────────────────────────────────────────────────────

  describe('GET /v2/:namespace/:name/manifests/:reference', () => {
    it('returns 404 when bundle is unknown', async () => {
      mockDbQueries.bundles.findFirst.mockResolvedValue(undefined);

      const res = await app.inject({ method: 'GET', url: '/v2/ns/name/manifests/v1.0.0' });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.errors[0].code).toBe('NAME_UNKNOWN');
    });

    it('returns 404 when version is unknown', async () => {
      mockDbQueries.bundles.findFirst.mockResolvedValue({ id: 1 });
      mockDbQueries.bundleVersions.findFirst.mockResolvedValue(undefined);

      const res = await app.inject({ method: 'GET', url: '/v2/ns/name/manifests/v1.0.0' });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.errors[0].code).toBe('MANIFEST_UNKNOWN');
    });

    it('returns manifest by tag with correct headers', async () => {
      const manifest = {
        schemaVersion: 2,
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: sha256('{}'), size: 2 },
        layers: [],
      };
      const digest = sha256(JSON.stringify(manifest));
      mockDbQueries.bundles.findFirst.mockResolvedValue({ id: 1 });
      mockDbQueries.bundleVersions.findFirst.mockResolvedValue({
        version: 'v1.0.0',
        digest,
        manifestJson: manifest,
      });

      const res = await app.inject({ method: 'GET', url: '/v2/ns/name/manifests/v1.0.0' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['docker-content-digest']).toBe(digest);
      // Fastify may append charset to content-type
      expect(res.headers['content-type']).toMatch(/^application\/vnd\.oci\.image\.manifest\.v1\+json/);
      expect(JSON.parse(res.body)).toEqual(manifest);
    });

    it('returns manifest by digest reference', async () => {
      const manifest = {
        schemaVersion: 2,
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: sha256('{}'), size: 2 },
        layers: [],
      };
      const digest = sha256(JSON.stringify(manifest));
      mockDbQueries.bundles.findFirst.mockResolvedValue({ id: 1 });
      mockDbQueries.bundleVersions.findFirst.mockResolvedValue({
        version: 'v1.0.0',
        digest,
        manifestJson: manifest,
      });

      const res = await app.inject({ method: 'GET', url: `/v2/ns/name/manifests/${digest}` });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual(manifest);
    });

    it('resolves "latest" tag to the newest version', async () => {
      const manifest = {
        schemaVersion: 2,
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: sha256('{}'), size: 2 },
        layers: [],
      };
      const digest = sha256(JSON.stringify(manifest));
      mockDbQueries.bundles.findFirst.mockResolvedValue({ id: 1 });
      // When reference is 'latest', the handler calls findFirst with orderBy instead of version match
      mockDbQueries.bundleVersions.findFirst.mockResolvedValue({
        version: 'v2.0.0',
        digest,
        manifestJson: manifest,
      });

      const res = await app.inject({ method: 'GET', url: '/v2/ns/name/manifests/latest' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['docker-content-digest']).toBe(digest);
      expect(JSON.parse(res.body)).toEqual(manifest);
    });

    it('returns 404 when no versions exist for "latest"', async () => {
      mockDbQueries.bundles.findFirst.mockResolvedValue({ id: 1 });
      mockDbQueries.bundleVersions.findFirst.mockResolvedValue(undefined);

      const res = await app.inject({ method: 'GET', url: '/v2/ns/name/manifests/latest' });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.errors[0].code).toBe('MANIFEST_UNKNOWN');
    });
  });

  describe('HEAD /v2/:namespace/:name/manifests/:reference', () => {
    it('returns 404 when bundle is unknown', async () => {
      mockDbQueries.bundles.findFirst.mockResolvedValue(undefined);

      const res = await app.inject({ method: 'HEAD', url: '/v2/ns/name/manifests/v1.0.0' });
      expect(res.statusCode).toBe(404);
    });

    it('returns headers for existing manifest', async () => {
      const manifest = {
        schemaVersion: 2,
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: sha256('{}'), size: 2 },
        layers: [],
      };
      const digest = sha256(JSON.stringify(manifest));
      mockDbQueries.bundles.findFirst.mockResolvedValue({ id: 1 });
      mockDbQueries.bundleVersions.findFirst.mockResolvedValue({
        version: 'v1.0.0',
        digest,
        manifestJson: manifest,
      });

      const res = await app.inject({ method: 'HEAD', url: '/v2/ns/name/manifests/v1.0.0' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['docker-content-digest']).toBe(digest);
      expect(res.headers['content-length']).toBe(String(JSON.stringify(manifest).length));
    });

    it('resolves "latest" tag to the newest version', async () => {
      const manifest = {
        schemaVersion: 2,
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: sha256('{}'), size: 2 },
        layers: [],
      };
      const digest = sha256(JSON.stringify(manifest));
      mockDbQueries.bundles.findFirst.mockResolvedValue({ id: 1 });
      mockDbQueries.bundleVersions.findFirst.mockResolvedValue({
        version: 'v2.0.0',
        digest,
        manifestJson: manifest,
      });

      const res = await app.inject({ method: 'HEAD', url: '/v2/ns/name/manifests/latest' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['docker-content-digest']).toBe(digest);
      expect(res.headers['content-length']).toBe(String(JSON.stringify(manifest).length));
    });
  });

  describe('PUT /v2/:namespace/:name/manifests/:reference', () => {
    it('rejects pushing manifest by digest reference', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/v2/ns/name/manifests/sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        headers: { 'content-type': 'application/vnd.oci.image.manifest.v1+json' },
        payload: JSON.stringify({ schemaVersion: 2, config: { mediaType: 'x', digest: sha256('{}'), size: 2 }, layers: [] }),
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.errors[0].code).toBe('TAG_INVALID');
    });

    it('rejects invalid manifest body', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/v2/ns/name/manifests/v1.0.0',
        headers: { 'content-type': 'application/vnd.oci.image.manifest.v1+json' },
        payload: JSON.stringify({ notAManifest: true }),
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.errors[0].code).toBe('MANIFEST_INVALID');
    });

    it('rejects manifest when referenced blob is missing', async () => {
      const manifest = {
        schemaVersion: 2,
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: sha256('{}'), size: 2 },
        layers: [
          { mediaType: 'application/octet-stream', digest: sha256('missing'), size: 5 },
        ],
      };
      mockDbQueries.blobs.findFirst.mockResolvedValue(undefined);

      const res = await app.inject({
        method: 'PUT',
        url: '/v2/ns/name/manifests/v1.0.0',
        headers: { 'content-type': 'application/vnd.oci.image.manifest.v1+json' },
        payload: JSON.stringify(manifest),
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.errors[0].code).toBe('BLOB_UNKNOWN');
    });

    it('creates bundle and version on first push', async () => {
      const manifest = {
        schemaVersion: 2,
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: sha256('{}'), size: 2 },
        layers: [],
        annotations: {
          'org.opencontainers.image.description': 'Test bundle',
        },
      };
      const manifestBytes = Buffer.from(JSON.stringify(manifest));
      const digest = sha256(manifestBytes);

      mockDbQueries.bundles.findFirst.mockResolvedValue(undefined);
      mockDbQueries.bundleVersions.findFirst.mockResolvedValue(undefined);
      mockDbInsert.mockImplementation(() => ({
        values: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue([{ id: 1, namespace: 'ns', name: 'name' }]),
        onConflictDoUpdate: vi.fn().mockReturnThis(),
      }));

      // Mock blob existence check for config descriptor
      mockDbQueries.blobs.findFirst.mockResolvedValue({ digest: manifest.config.digest, size: 2 });

      const res = await app.inject({
        method: 'PUT',
        url: '/v2/ns/name/manifests/v1.0.0',
        headers: { 'content-type': 'application/vnd.oci.image.manifest.v1+json' },
        payload: manifestBytes,
      });

      expect(res.statusCode).toBe(201);
      expect(res.headers['docker-content-digest']).toBe(digest);
      expect(res.headers.location).toBe(`/v2/ns/name/manifests/${digest}`);
    });

    it('returns 409 when version already exists', async () => {
      const manifest = {
        schemaVersion: 2,
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: sha256('{}'), size: 2 },
        layers: [],
      };
      mockDbQueries.bundles.findFirst.mockResolvedValue({ id: 1, namespace: 'ns', name: 'name' });
      mockDbQueries.bundleVersions.findFirst.mockResolvedValue({ version: 'v1.0.0' });
      mockDbQueries.blobs.findFirst.mockResolvedValue({ digest: manifest.config.digest, size: 2 });

      const res = await app.inject({
        method: 'PUT',
        url: '/v2/ns/name/manifests/v1.0.0',
        headers: { 'content-type': 'application/vnd.oci.image.manifest.v1+json' },
        payload: JSON.stringify(manifest),
      });
      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.errors[0].code).toBe('MANIFEST_INVALID');
    });

    it('creates extension bundle with hooks and compatibility metadata', async () => {
      const manifest = {
        schemaVersion: 2,
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: sha256('{}'), size: 2 },
        layers: [],
        annotations: {
          'dev.pekohub.metadata': JSON.stringify({
            bundleType: 'extension',
            extensionType: 'skill',
            description: 'A skill extension',
            author: 'alice',
            hooks: [
              { point: 'tool.register', handler: 'registerTools' },
              { point: 'agent.init', handler: 'onInit' },
            ],
            compatibility: { runtime: 'peko', minVersion: '1.0.0', maxVersion: '2.0.0' },
          }),
        },
      };
      const manifestBytes = Buffer.from(JSON.stringify(manifest));
      const digest = sha256(manifestBytes);

      mockDbQueries.bundles.findFirst.mockResolvedValue(undefined);
      mockDbQueries.bundleVersions.findFirst.mockResolvedValue(undefined);
      mockDbInsert.mockImplementation(() => ({
        values: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue([{
          id: 1,
          namespace: 'ns',
          name: 'ext',
          bundleType: 'extension',
          extensionType: 'skill',
          description: 'A skill extension',
          author: 'alice',
          hooks: [{ point: 'tool.register', handler: 'registerTools' }],
          compatibility: { runtime: 'peko', minVersion: '1.0.0' },
        }]),
        onConflictDoUpdate: vi.fn().mockReturnThis(),
      }));

      mockDbQueries.blobs.findFirst.mockResolvedValue({ digest: manifest.config.digest, size: 2 });

      const res = await app.inject({
        method: 'PUT',
        url: '/v2/ns/ext/manifests/v1.0.0',
        headers: { 'content-type': 'application/vnd.oci.image.manifest.v1+json' },
        payload: manifestBytes,
      });

      expect(res.statusCode).toBe(201);
      expect(res.headers['docker-content-digest']).toBe(digest);

      // Verify search index was called with extension metadata
      expect(app.search.indexBundle).toHaveBeenCalledWith(
        expect.objectContaining({
          bundleType: 'extension',
          extensionType: 'skill',
          hooks: expect.arrayContaining([
            expect.objectContaining({ point: 'tool.register' }),
          ]),
          compatibility: expect.objectContaining({ runtime: 'peko' }),
        })
      );
    });
  });
});