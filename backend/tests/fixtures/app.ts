import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";

import configPlugin from "../../src/plugins/config.js";
import authPlugin from "../../src/plugins/auth.js";
import { setDb } from "../../src/db/index.js";

import searchApiRoutes from "../../src/routes/api/search.js";
import bundleApiRoutes from "../../src/routes/api/bundles.js";
import instanceRoutes from "../../src/routes/api/instances.js";
import agentDirectoryRoutes from "../../src/routes/api/agents.js";
import adminRoutes from "../../src/routes/api/admin.js";
import oauthRoutes from "../../src/routes/auth/oauth.js";
import apiKeyRoutes from "../../src/routes/auth/api-keys.js";
import ociRoutes from "../../src/routes/oci/index.js";

import type { TestDb } from "./db.js";

export interface TestAppOptions {
  testDb: TestDb;
  jwtSecret?: string;
  enableOAuth?: boolean;
}

/**
 * Build a Fastify app configured for testing.
 * Uses the provided PGlite database instead of the real DATABASE_URL.
 */
export async function buildTestApp(options: TestAppOptions) {
  const jwtSecret =
    options.jwtSecret ?? "test-secret-key-that-is-32-chars-long!!";

  // Override environment for config plugin
  const originalEnv = { ...process.env };
  process.env.DATABASE_URL = "postgres://localhost:5432/pekohub_test";
  process.env.S3_ENDPOINT = "http://localhost:9000";
  process.env.S3_ACCESS_KEY = "test";
  process.env.S3_SECRET_KEY = "test";
  process.env.S3_BUCKET = "test-bucket";
  process.env.MEILISEARCH_URL = "http://localhost:7700";
  process.env.MEILISEARCH_API_KEY = "test";
  process.env.JWT_SECRET = jwtSecret;
  process.env.NODE_ENV = "test";
  process.env.GC_ENABLED = "false";
  process.env.RATE_LIMIT_MAX = "1000";
  process.env.ALLOW_DEV_AUTH_BYPASS = "false";

  if (options.enableOAuth) {
    process.env.GITHUB_CLIENT_ID = "test-github-id";
    process.env.GITHUB_CLIENT_SECRET = "test-github-secret";
    process.env.GOOGLE_CLIENT_ID = "test-google-id";
    process.env.GOOGLE_CLIENT_SECRET = "test-google-secret";
  } else {
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
  }

  // Replace the database instance before importing routes
  setDb(options.testDb.db);

  const app = Fastify({
    logger: false, // Silence logs in tests
    bodyLimit: 100 * 1024 * 1024,
  });

  // Content type parsers
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_req, body, done) => {
      done(null, body);
    },
  );
  app.addContentTypeParser(
    "application/vnd.oci.image.manifest.v1+json",
    { parseAs: "buffer" },
    (_req, body, done) => {
      done(null, body);
    },
  );
  app.addContentTypeParser(
    "application/vnd.oci.image.index.v1+json",
    { parseAs: "buffer" },
    (_req, body, done) => {
      done(null, body);
    },
  );

  // Register plugins
  await app.register(configPlugin);
  await app.register(cors, { origin: true, credentials: true });
  await app.register(cookie);
  await app.register(authPlugin);

  // Mock storage plugin
  app.decorate("storage", createMockStorage());

  // Mock search plugin
  app.decorate("search", createMockSearch());

  // Mock tunnel plugin (skip real WebSocket server in tests)
  app.decorate("tunnelManager", createMockTunnelManager());
  app.decorate("tunnelRouter", createMockTunnelRouter(app.tunnelManager));

  // Register routes
  await app.register(ociRoutes);
  await app.register(searchApiRoutes, { prefix: "/v1" });
  await app.register(bundleApiRoutes, { prefix: "/v1" });
  await app.register(instanceRoutes, { prefix: "/v1" });
  // Issue #14: agent directory (by-did / by-handle) for tests.
  await app.register(agentDirectoryRoutes, { prefix: "/v1" });
  await app.register(adminRoutes, { prefix: "/v1/admin" });
  await app.register(oauthRoutes, { prefix: "/v1/auth" });
  await app.register(apiKeyRoutes, { prefix: "/v1/auth" });

  // Health check
  app.get("/health", async () => ({ status: "ok", version: "0.1.0" }));

  // Error handler
  app.setErrorHandler((error, _request, reply) => {
    reply.status(error.statusCode ?? 500).send({
      error: error.message,
    });
  });

  // Cleanup: restore env
  process.env = originalEnv;

  return app;
}

function createMockStorage() {
  const store = new Map<string, Buffer>();
  return {
    async put(key: string, body: Buffer) {
      store.set(key, body);
    },
    async get(key: string) {
      const data = store.get(key);
      if (!data) throw new Error("Not found");
      return data;
    },
    async exists(key: string) {
      return store.has(key);
    },
    async delete(key: string) {
      store.delete(key);
    },
    async getSignedGetUrl(key: string) {
      return `http://mock-storage/${key}`;
    },
    async getSignedPutUrl(key: string) {
      return `http://mock-storage/${key}?upload`;
    },
  };
}

function createMockSearch() {
  const docs = new Map<string, any>();
  const instanceDocs = new Map<string, any>();
  return {
    async indexBundle(doc: any) {
      docs.set(doc.objectID, doc);
    },
    async search(query: string) {
      const hits = Array.from(docs.values()).filter((d: any) =>
        JSON.stringify(d).toLowerCase().includes(query.toLowerCase()),
      );
      return { hits, total: hits.length, page: 1, perPage: 20 };
    },
    async deleteBundle(objectID: string) {
      docs.delete(objectID);
    },
    async indexInstance(doc: any) {
      instanceDocs.set(doc.objectID, doc);
    },
    async searchInstances(query: string) {
      const hits = Array.from(instanceDocs.values()).filter((d: any) =>
        JSON.stringify(d).toLowerCase().includes(query.toLowerCase()),
      );
      return { hits, total: hits.length, page: 1, perPage: 20 };
    },
    async deleteInstance(objectID: string) {
      instanceDocs.delete(objectID);
    },
  };
}

function createMockTunnelManager() {
  return {
    startReaper() {},
    stopReaper() {},
    isRuntimeConnected() {
      return false;
    },
    async broadcastControl() {},
    async sendProxiedRequest() {
      throw new Error("Runtime not connected");
    },
    async startStream() {
      throw new Error("Runtime not connected");
    },
  };
}

function createMockTunnelRouter(
  manager: ReturnType<typeof createMockTunnelManager>,
) {
  return {
    async proxyChat(
      runtimeId: string,
      instanceId: string,
      _agentName: string,
      body: unknown,
      headers: Record<string, string>,
      reply: any,
    ) {
      if (!manager.isRuntimeConnected(runtimeId)) {
        return reply.status(502).send({ error: "Instance unreachable" });
      }
      throw new Error("Runtime not connected");
    },
    async proxyStream(
      runtimeId: string,
      instanceId: string,
      _agentName: string,
      body: unknown,
      headers: Record<string, string>,
      reply: any,
    ) {
      if (!manager.isRuntimeConnected(runtimeId)) {
        return reply.status(502).send({ error: "Instance unreachable" });
      }
      throw new Error("Runtime not connected");
    },
    async sendControl() {},
  };
}

// Type augmentation for mock plugins
declare module "fastify" {
  interface FastifyInstance {
    storage: ReturnType<typeof createMockStorage>;
    search: ReturnType<typeof createMockSearch>;
    tunnelManager: ReturnType<typeof createMockTunnelManager>;
    tunnelRouter: ReturnType<typeof createMockTunnelRouter>;
  }
}
