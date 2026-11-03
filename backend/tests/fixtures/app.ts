import Fastify from "fastify";
import { apiErrorHandler } from "../../src/plugins/errors.js";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";

import configPlugin from "../../src/plugins/config.js";
import authPlugin from "../../src/plugins/auth.js";
import { setDb } from "../../src/db/index.js";
import { createPostgresSearch } from "../../src/services/pg-search.js";

import searchApiRoutes from "../../src/routes/api/search.js";
import seedRoutes from "../../src/routes/api/seeds.js";
import instanceRoutes from "../../src/routes/api/instances.js";
import publicPekoRoutes from "../../src/routes/api/public-pekos.js";
import runtimeRoutes from "../../src/routes/api/runtimes.js";
import principalDirectoryRoutes from "../../src/routes/api/principals.js";
import adminRoutes from "../../src/routes/api/admin.js";
import reportRoutes from "../../src/routes/api/reports.js";
import metaRoutes from "../../src/routes/api/meta.js";
import groupRoutes from "../../src/routes/api/groups.js";
import oauthRoutes from "../../src/routes/auth/oauth.js";
import oauthServerRoutes from "../../src/routes/auth/oauth-server.js";
import apiKeyRoutes from "../../src/routes/auth/api-keys.js";
import opsRoutes, { type OpsRoutesOptions } from "../../src/routes/ops.js";

import type { TestDb } from "./db.js";

export interface TestAppOptions {
  testDb: TestDb;
  jwtSecret?: string;
  enableOAuth?: boolean;
  /** Anonymous visitor chat (`ALLOW_VISITOR_CHAT`); on unless set false. */
  allowVisitorChat?: boolean;
  /** Search the test database (the no-Meilisearch path) instead of the in-memory mock. */
  postgresSearch?: boolean;
  /** `/health` and `/metrics` options (src/routes/ops.ts). */
  ops?: OpsRoutesOptions;
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
  process.env.RATE_LIMIT_MAX = "1000";
  process.env.ALLOW_DEV_AUTH_BYPASS = "false";
  process.env.ALLOW_VISITOR_CHAT = options.allowVisitorChat === false ? "false" : "true";

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
  // OAuth token, device, and revoke requests are form-encoded (RFC 6749 §4.1.3)
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
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
  app.decorate(
    "search",
    options.postgresSearch ? createPostgresSearch(options.testDb.db as never) : createMockSearch(),
  );

  // Mock tunnel plugin (skip real WebSocket server in tests)
  app.decorate("tunnelManager", createMockTunnelManager());
  app.decorate("tunnelRouter", createMockTunnelRouter(app.tunnelManager));

  // Register routes
  await app.register(searchApiRoutes, { prefix: "/v1" });
  await app.register(seedRoutes, { prefix: "/v1" });
  await app.register(instanceRoutes, { prefix: "/v1" });
  await app.register(publicPekoRoutes, { prefix: "/v1" });
  await app.register(runtimeRoutes, { prefix: "/v1" });
  // Issue #14: agent directory (by-hub-id / by-handle) for tests.
  await app.register(principalDirectoryRoutes, { prefix: "/v1" });
  await app.register(adminRoutes, { prefix: "/v1/admin" });
  await app.register(reportRoutes, { prefix: "/v1" });
  await app.register(metaRoutes, { prefix: "/v1" });
  await app.register(groupRoutes, { prefix: "/v1" });
  await app.register(oauthRoutes, { prefix: "/v1/auth" });
  await app.register(apiKeyRoutes, { prefix: "/v1/auth" });
  await app.register(oauthServerRoutes);
  await app.register(opsRoutes, options.ops ?? {});

  // Error handler
  app.setErrorHandler(apiErrorHandler);

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
    async deleteBundleDocuments(objectIDs: string[]) {
      for (const id of objectIDs) docs.delete(id);
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
    notifyOwnerChanged() {},
    disconnectRuntime() {},
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
      _principalName: string,
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
      _principalName: string,
      body: unknown,
      headers: Record<string, string>,
      reply: any,
    ) {
      if (!manager.isRuntimeConnected(runtimeId)) {
        return reply.status(502).send({ error: "Instance unreachable" });
      }
      throw new Error("Runtime not connected");
    },
    async proxyHistory(): Promise<{ status: number; body: unknown }> {
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
