import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";

import { setDb } from "../../src/db/index.js";
import configPlugin from "../../src/plugins/config.js";
import authPlugin from "../../src/plugins/auth.js";
import { TunnelManager } from "../../src/services/tunnel-manager.js";
import { TunnelRouter } from "../../src/services/tunnel-router.js";
import instanceRoutes from "../../src/routes/api/instances.js";
import principalDirectoryRoutes from "../../src/routes/api/principals.js";

import type { TestDb } from "./db.js";

/**
 * Build a Fastify app with the real TunnelManager + TunnelRouter wired in,
 * plus mocked storage and search decorators. This is the same harness used
 * by the tunnel-proxy integration tests; extracted so transport_announce
 * tests can reuse it without copy-paste.
 */
export async function buildTunnelTestApp(testDb: TestDb) {
  const originalEnv = { ...process.env };
  process.env.DATABASE_URL = "postgres://localhost:5432/pekohub_test";
  process.env.S3_ENDPOINT = "http://localhost:9000";
  process.env.S3_ACCESS_KEY = "test";
  process.env.S3_SECRET_KEY = "test";
  process.env.S3_BUCKET = "test-bucket";
  process.env.MEILISEARCH_URL = "http://localhost:7700";
  process.env.MEILISEARCH_API_KEY = "test";
  process.env.JWT_SECRET = "test-secret-key-that-is-32-chars-long!!";
  process.env.NODE_ENV = "test";
  process.env.GC_ENABLED = "false";
  process.env.RATE_LIMIT_MAX = "1000";
  process.env.ALLOW_DEV_AUTH_BYPASS = "false";

  setDb(testDb.db);

  const app = Fastify({
    logger: false,
    bodyLimit: 100 * 1024 * 1024,
  });

  await app.register(configPlugin);
  await app.register(cors, { origin: true, credentials: true });
  await app.register(cookie);
  await app.register(authPlugin);

  // Real tunnel manager + router (not mocked)
  const tunnelManager = new TunnelManager(app);
  const tunnelRouter = new TunnelRouter(tunnelManager);
  app.decorate("tunnelManager", tunnelManager);
  app.decorate("tunnelRouter", tunnelRouter);

  // Mock storage
  app.decorate("storage", {
    async put() {},
    async get() {
      return Buffer.from("");
    },
    async exists() {
      return true;
    },
    async delete() {},
    async getSignedGetUrl(key: string) {
      return `http://mock-storage/${key}`;
    },
    async getSignedPutUrl(key: string) {
      return `http://mock-storage/${key}?upload`;
    },
  });

  // Mock search
  app.decorate("search", {
    async indexBundle() {},
    async search() {
      return { hits: [], total: 0, page: 1, perPage: 20 };
    },
    async deleteBundle() {},
    async indexInstance() {},
    async searchInstances() {
      return { hits: [], total: 0, page: 1, perPage: 20 };
    },
    async deleteInstance() {},
  });

  await app.register(instanceRoutes, { prefix: "/v1" });
  // Issue #14: directory API is what integration tests assert against
  // after an instance_announce.
  await app.register(principalDirectoryRoutes, { prefix: "/v1" });

  app.get("/health", async () => ({ status: "ok" }));

  app.setErrorHandler((error, _request, reply) => {
    reply.status(error.statusCode ?? 500).send({
      error: error.message,
    });
  });

  process.env = originalEnv;

  return { app, tunnelManager, tunnelRouter };
}
