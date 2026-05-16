import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

process.env.NODE_ENV = 'development';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockDbQueries = {
  users: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
  },
};

const mockDbInsert = vi.fn();

export function resetMocks() {
  mockDbQueries.users.findFirst.mockReset();
  mockDbQueries.users.findMany.mockReset();
  mockDbInsert.mockClear();
}

vi.mock('../../../db/index.js', () => ({
  db: {
    query: mockDbQueries,
    insert: mockDbInsert.mockReturnValue({
      values: vi.fn().mockReturnThis(),
      returning: vi.fn(),
    }),
  },
}));

// Import routes after mocking db
const { default: oauthRoutes } = await import('../oauth.js');

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

  app.decorate('authenticate', vi.fn().mockResolvedValue({
    id: 1,
    namespace: 'alice',
    displayName: 'Alice',
    email: 'alice@example.com',
    avatarUrl: 'https://example.com/avatar.png',
  }));

  await app.register(import('@fastify/cookie'));
  await app.register(oauthRoutes, { prefix: '/api/v1/auth' });
  await app.ready();
  return app;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Auth Routes', () => {
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

  describe('GET /api/v1/auth/me', () => {
    it('returns the authenticated user profile', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { authorization: 'Bearer test-token' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toEqual({
        id: 1,
        namespace: 'alice',
        displayName: 'Alice',
        email: 'alice@example.com',
        avatarUrl: 'https://example.com/avatar.png',
      });
    });

    it('returns 401 when not authenticated', async () => {
      (app.authenticate as any).mockRejectedValueOnce(new Error('Unauthorized'));

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Unauthorized');
    });
  });

  describe('POST /api/v1/auth/logout', () => {
    it('clears the pekohub_session cookie and returns success', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);

      const setCookie = res.headers['set-cookie'];
      expect(setCookie).toBeDefined();
      const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      expect(cookieHeader).toContain('pekohub_session=');
      expect(cookieHeader).toMatch(/Expires=Thu, 01 Jan 1970 00:00:00 GMT|Max-Age=0/);
    });
  });
});
