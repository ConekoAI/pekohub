import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// Set NODE_ENV=development BEFORE importing routes
process.env.NODE_ENV = 'development';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockDbQueries = {
  bundles: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
  },
  bundleVersions: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
  },
};

const mockDbInsert = vi.fn();
const mockDbUpdate = vi.fn();

export function resetMocks() {
  mockDbQueries.bundles.findFirst.mockReset();
  mockDbQueries.bundles.findMany.mockReset();
  mockDbQueries.bundleVersions.findFirst.mockReset();
  mockDbQueries.bundleVersions.findMany.mockReset();
  mockDbInsert.mockClear();
  mockDbUpdate.mockClear();
}

vi.mock('../../../db/index.js', () => ({
  db: {
    query: mockDbQueries,
    insert: mockDbInsert.mockReturnValue({
      values: vi.fn().mockReturnThis(),
      returning: vi.fn(),
    }),
    update: mockDbUpdate.mockReturnValue({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn(),
    }),
  },
}));

vi.mock('../../../services/audit.js', () => ({
  auditService: {
    logPermissionChange: vi.fn().mockResolvedValue(undefined),
    logPush: vi.fn().mockResolvedValue(undefined),
    logPull: vi.fn().mockResolvedValue(undefined),
    logDelete: vi.fn().mockResolvedValue(undefined),
  },
}));

// Import routes after mocking db
const { default: bundleRoutes } = await import('../bundles.js');

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.decorate('config', {
    PORT: '3000',
    HOST: '0.0.0.0',
    NODE_ENV: 'development',
    DATABASE_URL: 'postgres://test',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_REGION: 'us-east-1',
    S3_ACCESS_KEY: 'test',
    S3_SECRET_KEY: 'test',
    S3_BUCKET: 'pekohub-blobs',
    S3_FORCE_PATH_STYLE: 'true',
    MEILISEARCH_URL: 'http://localhost:7700',
    MEILISEARCH_API_KEY: 'test',
    JWT_SECRET: 'test-secret-that-is-at-least-32-characters-long',
    REGISTRY_BASE_URL: 'http://localhost:3000',
    ALLOW_DEV_AUTH_BYPASS: 'true',
    RATE_LIMIT_MAX: 100,
    RATE_LIMIT_WINDOW_MS: 60000,
    GC_ENABLED: 'true',
    GC_INTERVAL_MS: 86400000,
    GC_RETENTION_DAYS: 7,
    GC_BATCH_SIZE: 1000,
  } as any);

  app.decorate('authenticate', vi.fn().mockResolvedValue({ id: 42, namespace: 'forker' }));

  app.decorate('search', {
    indexBundle: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue({ hits: [], total: 0, page: 1, perPage: 20 }),
    deleteBundle: vi.fn().mockResolvedValue(undefined),
  });

  await app.register(bundleRoutes, { prefix: '/v1' });
  await app.ready();
  return app;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Bundle API Routes', () => {
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

  describe('POST /v1/bundles/:namespace/:name/fork', () => {
    it('forks a bundle to the authenticated namespace', async () => {
      const sourceBundle = {
        id: 1,
        namespace: 'acme',
        name: 'alpha',
        bundleType: 'agent',
        extensionType: null,
        description: 'A test agent',
        author: 'alice',
        license: 'MIT',
        tags: ['ai'],
        categories: ['research'],
        modelProviders: ['openai'],
        requiredMcpServers: null,
        homepage: null,
        repository: null,
        readme: '# Alpha',
        forkedFrom: null,
        starCount: 5,
        pullCount: 100,
      };

      const sourceVersions = [
        { id: 10, bundleId: 1, version: 'v1.0.0', digest: 'sha256:abc', manifestJson: {}, size: 100, deprecated: false, deprecatedMessage: null },
        { id: 11, bundleId: 1, version: 'v1.1.0', digest: 'sha256:def', manifestJson: {}, size: 200, deprecated: false, deprecatedMessage: null },
      ];

      mockDbQueries.bundles.findFirst
        .mockResolvedValueOnce(sourceBundle) // source lookup
        .mockResolvedValueOnce(undefined); // conflict check

      mockDbQueries.bundleVersions.findMany.mockResolvedValue(sourceVersions);

      mockDbInsert.mockImplementation(() => ({
        values: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue([{
          id: 99,
          namespace: 'forker',
          name: 'alpha',
          forkedFrom: 'acme/alpha',
        }]),
      }));

      const res = await app.inject({
        method: 'POST',
        url: '/v1/bundles/acme/alpha/fork',
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.namespace).toBe('forker');
      expect(body.name).toBe('alpha');
      expect(body.forkedFrom).toBe('acme/alpha');
      expect(body.versionsCopied).toBe(2);
    });

    it('returns 404 when source bundle does not exist', async () => {
      mockDbQueries.bundles.findFirst.mockResolvedValue(undefined);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/bundles/acme/missing/fork',
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Bundle not found');
    });

    it('returns 409 when target bundle already exists', async () => {
      const sourceBundle = {
        id: 1,
        namespace: 'acme',
        name: 'alpha',
        bundleType: 'agent',
        extensionType: null,
        description: null,
        author: null,
        license: null,
        tags: null,
        categories: null,
        modelProviders: null,
        requiredMcpServers: null,
        homepage: null,
        repository: null,
        readme: null,
        forkedFrom: null,
        starCount: 0,
        pullCount: 0,
      };

      mockDbQueries.bundles.findFirst
        .mockResolvedValueOnce(sourceBundle)
        .mockResolvedValueOnce({ id: 99, namespace: 'forker', name: 'alpha' }); // conflict

      const res = await app.inject({
        method: 'POST',
        url: '/v1/bundles/acme/alpha/fork',
      });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.error).toContain('already exists');
    });

    it('supports optional targetName query param', async () => {
      const sourceBundle = {
        id: 1,
        namespace: 'acme',
        name: 'alpha',
        bundleType: 'agent',
        extensionType: null,
        description: null,
        author: null,
        license: null,
        tags: null,
        categories: null,
        modelProviders: null,
        requiredMcpServers: null,
        homepage: null,
        repository: null,
        readme: null,
        forkedFrom: null,
        starCount: 0,
        pullCount: 0,
      };

      mockDbQueries.bundles.findFirst
        .mockResolvedValueOnce(sourceBundle)
        .mockResolvedValueOnce(undefined);

      mockDbQueries.bundleVersions.findMany.mockResolvedValue([]);

      mockDbInsert.mockImplementation(() => ({
        values: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue([{
          id: 99,
          namespace: 'forker',
          name: 'beta',
          forkedFrom: 'acme/alpha',
        }]),
      }));

      const res = await app.inject({
        method: 'POST',
        url: '/v1/bundles/acme/alpha/fork?targetName=beta',
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.name).toBe('beta');
      expect(body.forkedFrom).toBe('acme/alpha');
    });
  });
});
