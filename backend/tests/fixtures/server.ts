import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';

import configPlugin from '../../src/plugins/config.js';
import authPlugin from '../../src/plugins/auth.js';
import { setDb } from '../../src/db/index.js';

import searchApiRoutes from '../../src/routes/api/search.js';
import bundleApiRoutes from '../../src/routes/api/bundles.js';
import adminRoutes from '../../src/routes/api/admin.js';
import oauthRoutes from '../../src/routes/auth/oauth.js';
import apiKeyRoutes from '../../src/routes/auth/api-keys.js';
import ociRoutes from '../../src/routes/oci/index.js';

import { createTestDb } from './db.js';

/**
 * Parse --port argument from process.argv.
 * Usage: npx tsx tests/fixtures/server.ts --port 0
 */
function parsePortArg(): number {
  const idx = process.argv.indexOf('--port');
  if (idx !== -1 && process.argv[idx + 1]) {
    const port = parseInt(process.argv[idx + 1], 10);
    if (!isNaN(port)) return port;
  }
  return 0;
}

function createMockStorage() {
  const store = new Map<string, Buffer>();
  return {
    async put(key: string, body: Buffer) {
      store.set(key, body);
    },
    async get(key: string) {
      const data = store.get(key);
      if (!data) throw new Error('Not found');
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
  return {
    async indexBundle(doc: any) {
      docs.set(doc.objectID, doc);
    },
    async search(query: string) {
      const hits = Array.from(docs.values()).filter((d: any) =>
        JSON.stringify(d).toLowerCase().includes(query.toLowerCase())
      );
      return { hits, total: hits.length, page: 1, perPage: 20 };
    },
    async deleteBundle(objectID: string) {
      docs.delete(objectID);
    },
  };
}

async function main() {
  const port = parsePortArg();
  const testDb = await createTestDb();

  // Override environment for config plugin
  const originalEnv = { ...process.env };
  process.env.DATABASE_URL = 'postgres://localhost:5432/pekohub_test';
  process.env.S3_ENDPOINT = 'http://localhost:9000';
  process.env.S3_ACCESS_KEY = 'test';
  process.env.S3_SECRET_KEY = 'test';
  process.env.S3_BUCKET = 'test-bucket';
  process.env.MEILISEARCH_URL = 'http://localhost:7700';
  process.env.MEILISEARCH_API_KEY = 'test';
  process.env.JWT_SECRET = 'test-secret-key-that-is-32-chars-long!!';
  process.env.NODE_ENV = 'development';
  process.env.GC_ENABLED = 'false';
  process.env.RATE_LIMIT_MAX = '1000';
  process.env.ALLOW_DEV_AUTH_BYPASS = 'true';

  // Replace the database instance before importing routes
  setDb(testDb.db);

  const app = Fastify({
    logger: false,
    bodyLimit: 100 * 1024 * 1024,
  });

  // Content type parsers
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });
  app.addContentTypeParser('application/vnd.oci.image.manifest.v1+json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });
  app.addContentTypeParser('application/vnd.oci.image.index.v1+json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });
  app.addContentTypeParser('application/vnd.peko.manifest.v1+json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  // Register plugins
  await app.register(configPlugin);
  await app.register(cors, { origin: true, credentials: true });
  await app.register(cookie);
  await app.register(authPlugin);

  // Mock storage plugin
  app.decorate('storage', createMockStorage());

  // Mock search plugin
  app.decorate('search', createMockSearch());

  // Register routes
  await app.register(ociRoutes);
  await app.register(searchApiRoutes, { prefix: '/api/v1' });
  await app.register(bundleApiRoutes, { prefix: '/api/v1' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.register(oauthRoutes, { prefix: '/api/v1/auth' });
  await app.register(apiKeyRoutes, { prefix: '/api/v1/auth' });

  // Health check
  app.get('/health', async () => ({ status: 'ok', version: '0.1.0' }));

  // Error handler
  app.setErrorHandler((error, _request, reply) => {
    reply.status(error.statusCode ?? 500).send({
      error: error.message,
    });
  });

  // Cleanup: restore env
  process.env = originalEnv;

  await app.listen({ port, host: '127.0.0.1' });

  const address = app.server.address();
  const boundPort = typeof address === 'string' ? port : address?.port ?? port;

  console.log(`PORT=${boundPort}`);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    await app.close();
    await testDb.client.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

declare module 'fastify' {
  interface FastifyInstance {
    storage: ReturnType<typeof createMockStorage>;
    search: ReturnType<typeof createMockSearch>;
  }
}
