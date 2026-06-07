import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import rateLimit from '@fastify/rate-limit';

import configPlugin from './plugins/config.js';
import authPlugin from './plugins/auth.js';
import storagePlugin from './plugins/storage.js';
import searchPlugin from './plugins/search.js';

import ociRoutes from './routes/oci/index.js';
import searchApiRoutes from './routes/api/search.js';
import bundleApiRoutes from './routes/api/bundles.js';
import instanceRoutes from './routes/api/instances.js';
import adminRoutes from './routes/api/admin.js';
import oauthRoutes from './routes/auth/oauth.js';
import apiKeyRoutes from './routes/auth/api-keys.js';

import { GarbageCollector } from './services/gc.js';
import { Scheduler } from './services/scheduler.js';

async function main() {
  const app = Fastify({
    logger: {
      level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
      transport: process.env.NODE_ENV !== 'production' ? { target: 'pino-pretty' } : undefined,
    },
    // Increase body size limit for blob uploads (100MB)
    bodyLimit: 100 * 1024 * 1024,
    // Trust X-Forwarded-For from nginx/Cloudflare so request.ip is the real client IP
    trustProxy: true,
  });

  // Allow raw binary bodies for OCI blob uploads
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });
  // Allow OCI manifest content types
  app.addContentTypeParser('application/vnd.oci.image.manifest.v1+json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });
  app.addContentTypeParser('application/vnd.oci.image.index.v1+json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });
  // Allow legacy CLI manifest content type (peko-runtime uses this)
  app.addContentTypeParser('application/vnd.peko.manifest.v1+json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  // Register plugins
  await app.register(configPlugin);
  await app.register(cors, {
    origin: [
      'http://localhost:5173',
      'http://localhost:3000',
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

  // Swagger / OpenAPI
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'PekoHub Registry API',
        description: 'OCI Distribution Spec v1.1 + PekoHub custom APIs',
        version: '1.0.0',
      },
      servers: [{ url: 'http://localhost:3000' }],
    },
  });
  await app.register(swaggerUi, {
    routePrefix: '/docs',
  });

  // Health check
  app.get('/health', async () => ({ status: 'ok', version: '0.1.0', deployedVia: 'github-actions' }));

  // OCI Distribution Spec routes — registered via single aggregator
  await app.register(ociRoutes);

  // Custom API routes
  await app.register(searchApiRoutes, { prefix: '/v1' });
  await app.register(bundleApiRoutes, { prefix: '/v1' });
  await app.register(instanceRoutes, { prefix: '/v1' });
  await app.register(adminRoutes, { prefix: '/v1/admin' });
  await app.register(oauthRoutes, { prefix: '/v1/auth' });
  await app.register(apiKeyRoutes, { prefix: '/v1/auth' });

  // Stricter rate limits for auth endpoints
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/v1/auth/')) {
      // Use a simple in-memory rate limiter for auth endpoints
      // @fastify/rate-limit doesn't support prefix-based scoping,
      // so we apply a custom hook here.
      const key = `ratelimit:auth:${request.ip}`;
      const now = Date.now();
      const windowMs = 60_000;
      const max = 10;
      const store = (app as any)._authRateLimitStore ?? new Map<string, number[]>();
      (app as any)._authRateLimitStore = store;

      const timestamps = store.get(key) ?? [];
      const valid = timestamps.filter((t: number) => now - t < windowMs);
      if (valid.length >= max) {
        reply.header('Retry-After', Math.ceil(windowMs / 1000));
        return reply.status(429).send({ error: 'Too many requests' });
      }
      valid.push(now);
      store.set(key, valid);
    }
  });

  // Error handler
  app.setErrorHandler((error, request, reply) => {
    app.log.error(error);
    reply.status(error.statusCode ?? 500).send({
      error: error.message,
      ...(process.env.NODE_ENV === 'development' ? { stack: error.stack } : {}),
    });
  });

  const port = Number(app.config.PORT);
  const host = app.config.HOST;

  try {
    await app.listen({ port, host });
    app.log.info(`🚀 PekoHub registry server running at http://${host}:${port}`);
    app.log.info(`📚 API docs at http://${host}:${port}/docs`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // ── Scheduled garbage collection ────────────────────────────────────────────
  const scheduler = new Scheduler(app.log);

  if (app.config.GC_ENABLED === 'true') {
    const gc = new GarbageCollector(app.storage);

    scheduler.addJob('garbage-collection', app.config.GC_INTERVAL_MS, async () => {
      const result = await gc.collect({
        retentionDays: app.config.GC_RETENTION_DAYS,
        dryRun: false,
        batchSize: app.config.GC_BATCH_SIZE,
      });

      app.log.info(
        `GC completed — blobsScanned=${result.blobsScanned} blobsDeleted=${result.blobsDeleted} bytesFreed=${result.bytesFreed} errors=${result.errors.length}`
      );

      if (result.errors.length > 0) {
        for (const error of result.errors) {
          app.log.error(`GC error: ${error}`);
        }
      }
    });

    scheduler.start();
    app.log.info(
      `Scheduled GC enabled (interval=${app.config.GC_INTERVAL_MS}ms, retention=${app.config.GC_RETENTION_DAYS}days, batchSize=${app.config.GC_BATCH_SIZE})`
    );
  } else {
    app.log.info('Scheduled GC disabled');
  }

  // ── Graceful shutdown ───────────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    app.log.info(`Received ${signal}, shutting down gracefully...`);
    scheduler.stop();
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
