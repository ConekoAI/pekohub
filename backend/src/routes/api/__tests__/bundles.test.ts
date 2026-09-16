import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  vi,
  beforeEach,
} from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

// Set NODE_ENV=development BEFORE importing routes
process.env.NODE_ENV = "development";

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
  blobs: {
    findFirst: vi.fn(),
  },
};

const mockDbInsert = vi.fn();
const mockDbUpdate = vi.fn();
const mockDbDelete = vi.fn();

export function resetMocks() {
  mockDbQueries.bundles.findFirst.mockReset();
  mockDbQueries.bundles.findMany.mockReset();
  mockDbQueries.bundleVersions.findFirst.mockReset();
  mockDbQueries.bundleVersions.findMany.mockReset();
  mockDbQueries.blobs.findFirst.mockReset();
  mockDbInsert.mockClear();
  mockDbUpdate.mockClear();
  mockDbDelete.mockClear();
}

vi.mock("../../../db/index.js", () => ({
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
    delete: mockDbDelete.mockReturnValue({
      where: vi.fn().mockReturnThis(),
    }),
  },
}));

vi.mock("../../../services/audit.js", () => ({
  auditService: {
    logPermissionChange: vi.fn().mockResolvedValue(undefined),
    logPush: vi.fn().mockResolvedValue(undefined),
    logPull: vi.fn().mockResolvedValue(undefined),
    logDelete: vi.fn().mockResolvedValue(undefined),
  },
}));

// Import routes after mocking db
const { default: bundleRoutes } = await import("../bundles.js");

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.decorate("config", {
    PORT: "3000",
    HOST: "0.0.0.0",
    NODE_ENV: "development",
    DATABASE_URL: "postgres://test",
    S3_ENDPOINT: "http://localhost:9000",
    S3_REGION: "us-east-1",
    S3_ACCESS_KEY: "test",
    S3_SECRET_KEY: "test",
    S3_BUCKET: "pekohub-blobs",
    S3_FORCE_PATH_STYLE: "true",
    MEILISEARCH_URL: "http://localhost:7700",
    MEILISEARCH_API_KEY: "test",
    JWT_SECRET: "test-secret-that-is-at-least-32-characters-long",
    REGISTRY_BASE_URL: "http://localhost:3000",
    ALLOW_DEV_AUTH_BYPASS: "true",
    RATE_LIMIT_MAX: 100,
    RATE_LIMIT_WINDOW_MS: 60000,
    GC_ENABLED: "true",
    GC_INTERVAL_MS: 86400000,
    GC_RETENTION_DAYS: 7,
    GC_BATCH_SIZE: 1000,
  } as any);

  app.decorate(
    "authenticate",
    vi.fn().mockResolvedValue({ id: 42, namespace: "forker" }),
  );

  app.decorate("search", {
    indexBundle: vi.fn().mockResolvedValue(undefined),
    search: vi
      .fn()
      .mockResolvedValue({ hits: [], total: 0, page: 1, perPage: 20 }),
    deleteBundleDocuments: vi.fn().mockResolvedValue(undefined),
    indexInstance: vi.fn().mockResolvedValue(undefined),
    searchInstances: vi
      .fn()
      .mockResolvedValue({ hits: [], total: 0, page: 1, perPage: 20 }),
    deleteInstance: vi.fn().mockResolvedValue(undefined),
  });

  // Mock storage
  const storageMap = new Map<string, Buffer>();
  app.decorate("storage", {
    put: async (key: string, body: Buffer) => {
      storageMap.set(key, body);
    },
    get: async (key: string) => storageMap.get(key) ?? Buffer.from([]),
    exists: async (key: string) => storageMap.has(key),
    delete: async (key: string) => {
      storageMap.delete(key);
    },
    getSignedGetUrl: async () => "http://signed",
    getSignedPutUrl: async () => "http://signed",
  });

  await app.register(bundleRoutes, { prefix: "/v1" });
  await app.ready();
  return app;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Bundle API Routes", () => {
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

  describe("POST /v1/bundles/:namespace/:name/fork (retired)", () => {
    // Forking belonged to the package catalog. A template is DNA: it is
    // re-pushed from a workspace with `peko push`, never copied out of the
    // registry, so the endpoint is gone rather than deprecated.
    it("is no longer routed", async () => {
      mockDbQueries.bundles.findFirst.mockResolvedValue({
        id: 1,
        namespace: "acme",
        name: "alpha",
        publisherId: 42,
      });

      const res = await app.inject({
        method: "POST",
        url: "/v1/bundles/acme/alpha/fork",
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe("DELETE /v1/bundles/:namespace/:name", () => {
    it("deletes a bundle and removes orphaned blobs from storage", async () => {
      const bundle = {
        id: 1,
        namespace: "acme",
        name: "alpha",
        // ADR-056: the mocked caller (`authenticate` above) is the
        // publisher, so the ownership check passes.
        publisherId: 42,
      };

      const digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const storageKey = `blobs/${digest}`;

      mockDbQueries.bundles.findFirst.mockResolvedValue(bundle);
      mockDbQueries.bundleVersions.findMany
        // First call: the bundle's own versions (digest collection)
        .mockResolvedValueOnce([
          {
            id: 10,
            bundleId: 1,
            version: "v1.0.0",
            digest,
            manifestJson: {
              layers: [{ digest }],
              config: { digest },
            },
            size: 100,
          },
        ])
        // Later calls: other bundles' versions — none reference the digest
        .mockResolvedValue([]);
      mockDbQueries.blobs.findFirst.mockResolvedValue({
        digest,
        storageKey,
        size: 100,
      });

      // Pre-seed storage
      await app.storage.put(storageKey, Buffer.from("blob content"));
      expect(await app.storage.exists(storageKey)).toBe(true);

      const res = await app.inject({
        method: "DELETE",
        url: "/v1/bundles/acme/alpha",
      });

      expect(res.statusCode).toBe(204);
      // Blob should be removed from storage within the same request
      expect(await app.storage.exists(storageKey)).toBe(false);
    });
  });
});
