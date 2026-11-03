import "dotenv/config";
import { bridgeJwks } from "./services/bridge-token.js";
import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import rateLimit from "@fastify/rate-limit";

import configPlugin from "./plugins/config.js";
import authPlugin from "./plugins/auth.js";
import storagePlugin from "./plugins/storage.js";
import searchPlugin from "./plugins/search.js";
import tunnelPlugin from "./plugins/tunnel.js";
import quotaPlugin from "./plugins/quotas.js";
import { apiErrorHandler } from "./plugins/errors.js";
import { WindowLimiter } from "./services/window-limiter.js";

import searchApiRoutes from "./routes/api/search.js";
import seedRoutes from "./routes/api/seeds.js";
import runtimeRoutes from "./routes/api/runtimes.js";
import instanceRoutes from "./routes/api/instances.js";
import publicPekoRoutes from "./routes/api/public-pekos.js";
import principalDirectoryRoutes from "./routes/api/principals.js";
import adminRoutes from "./routes/api/admin.js";
import metaRoutes from "./routes/api/meta.js";
import groupRoutes from "./routes/api/groups.js";
import oauthRoutes from "./routes/auth/oauth.js";
import apiKeyRoutes from "./routes/auth/api-keys.js";
import oauthServerRoutes from "./routes/auth/oauth-server.js";

import { Scheduler } from "./services/scheduler.js";
import { metrics } from "./services/metrics.js";
import { instanceService } from "./services/instances.js";

async function main() {
  const app = Fastify({
    logger: {
      level: process.env.NODE_ENV === "production" ? "info" : "debug",
      transport:
        process.env.NODE_ENV !== "production"
          ? { target: "pino-pretty" }
          : undefined,
    },
    // Seeds are at most 64 KB; nothing else posts large bodies.
    bodyLimit: 1024 * 1024,
    // Trust X-Forwarded-For from nginx/Cloudflare so request.ip is the real client IP
    trustProxy: true,
  });

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
  await app.register(cors, {
    origin: [
      "http://localhost:5173",
      "http://localhost:3000",
      ...(process.env.FRONTEND_URL ? [process.env.FRONTEND_URL] : []),
    ],
    credentials: true,
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    max: app.config.RATE_LIMIT_MAX,
    timeWindow: app.config.RATE_LIMIT_WINDOW_MS,
  });
  await app.register(authPlugin);
  await app.register(storagePlugin);
  await app.register(searchPlugin);
  await app.register(tunnelPlugin);
  await app.register(quotaPlugin);

  // Swagger / OpenAPI
  await app.register(swagger, {
    openapi: {
      info: {
        title: "PekoHub Registry API",
        description: "OCI Distribution Spec v1.1 + PekoHub custom APIs",
        version: "1.0.0",
      },
      servers: [{ url: "http://localhost:3000" }],
    },
  });
  await app.register(swaggerUi, {
    routePrefix: "/docs",
  });

  // Health check
  app.get("/health", async () => ({
    status: "ok",
    version: "0.1.0",
    deployedVia: "github-actions",
  }));

  // Issue #16: in-process counter snapshot. Intentionally unauthenticated
  // — the counters are diagnostic, not authoritative, and exposing them
  // on a sidecar / metrics-scrape path is the typical deployment.
  app.get("/metrics", async () => metrics.snapshot());

  // Custom API routes
  await app.register(searchApiRoutes, { prefix: "/v1" });
  // The seed registry (runtime ADR-060)
  await app.register(seedRoutes, { prefix: "/v1" });
  // Issue #15: runtime registration (POST /v1/runtimes/register) was dead
  // code — the routes/api/index.ts aggregator was never imported, so
  // `peko tunnel setup` calls were silently 404ing in production. Register
  // the route file directly under /v1 to match the rest of the API.
  await app.register(runtimeRoutes, { prefix: "/v1" });
  await app.register(instanceRoutes, { prefix: "/v1" });
  // ADR-059: web-facing public peko surface (page data, public chat,
  // accessible-pekos) — renamed from the retired /v1/public/principals/*
  // paths, which now 404 (clean rename, no aliases).
  await app.register(publicPekoRoutes, { prefix: "/v1" });
  // Issue #14: principal directory (by-did / by-handle) for the cross-runtime
  // principal_send resolver. Mounted under /v1 to match the rest of the
  // public API; both endpoints require auth (JWT or API key) so
  // `fastify.authenticate` is the gate.
  await app.register(principalDirectoryRoutes, { prefix: "/v1" });
  await app.register(adminRoutes, { prefix: "/v1/admin" });
  await app.register(metaRoutes, { prefix: "/v1" });
  await app.register(groupRoutes, { prefix: "/v1" });

  // ADR-057: bridge-token verification keys. Runtimes fetch this to
  // validate the EdDSA tokens the hub mints when proxying chat (the
  // runtime derives `{origin}/v1/jwks.json` from its pekohub
  // credential); the /.well-known path is the conventional alias.
  const jwksHandler = async () => bridgeJwks(app.config.JWT_SECRET);
  app.get("/v1/jwks.json", jwksHandler);
  app.get("/.well-known/jwks.json", jwksHandler);
  await app.register(oauthRoutes, { prefix: "/v1/auth" });
  await app.register(apiKeyRoutes, { prefix: "/v1/auth" });
  // OAuth authorization server for Peko desktop + CLI sign-in
  await app.register(oauthServerRoutes);

  // OAuth protocol endpoints: device polling runs every few seconds, so
  // a looser per-IP cap than the sign-in endpoints below.
  const oauthLimiter = new WindowLimiter(60, 60_000);
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/oauth/")) return;
    if (!oauthLimiter.allow(request.ip)) {
      reply.header("Retry-After", oauthLimiter.retryAfterSeconds);
      return reply.status(429).send({ error: "slow_down" });
    }
  });

  // A stricter per-IP cap on sign-in and account endpoints (@fastify/rate-limit
  // has no prefix scoping). `/me` and `/refresh` run on every website load,
  // and many people can share one IP, so they stay under the global cap.
  const authLimiter = new WindowLimiter(20, 60_000);
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/v1/auth/")) return;
    const path = request.url.split("?")[0];
    if (path === "/v1/auth/me" || path === "/v1/auth/refresh") return;
    if (!authLimiter.allow(request.ip)) {
      reply.header("Retry-After", authLimiter.retryAfterSeconds);
      return reply.status(429).send({ error: "Too many requests" });
    }
  });

  app.setErrorHandler(apiErrorHandler);

  const port = Number(app.config.PORT);
  const host = app.config.HOST;

  try {
    await app.listen({ port, host });
    app.log.info(
      `🚀 PekoHub registry server running at http://${host}:${port}`,
    );
    app.log.info(`📚 API docs at http://${host}:${port}/docs`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // ── Scheduled jobs ─────────────────────────────────────────────────────────
  const scheduler = new Scheduler(app.log);

  // Issue #15: defense-in-depth sweep for stranded online rows. The tunnel
  // dispatcher marks instances offline on socket close via
  // `propagateRuntimeOffline` (`tunnel-manager.ts:1074`), but a crashed
  // hub-side process leaves rows at `status = "online"` forever. The
  // runtime-side heartbeat timeout (90s) is authoritative at the
  // protocol level; this sweep is the safety net.
  scheduler.addJob(
    "mark-offline-if-stale",
    60_000,
    async () => {
      const n = await instanceService.markOfflineIfStale(90_000);
      if (n > 0) {
        app.log.info(
          `Swept ${n} stale online instance(s) to offline (lastSeenAt > 90s ago)`,
        );
      }
    },
  );

  scheduler.start();
  app.log.info("Scheduler started (mark-offline-if-stale every 60s)");

  // ── Graceful shutdown ───────────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    app.log.info(`Received ${signal}, shutting down gracefully...`);
    scheduler.stop();
    await app.close();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main();
