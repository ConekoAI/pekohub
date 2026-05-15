import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';

import configPlugin from './plugins/config.js';
import authPlugin from './plugins/auth.js';
import storagePlugin from './plugins/storage.js';
import searchPlugin from './plugins/search.js';

import catalogRoutes from './routes/oci/catalog.js';
import blobRoutes from './routes/oci/blobs.js';
import manifestRoutes from './routes/oci/manifests.js';
import tagRoutes from './routes/oci/tags.js';

import searchApiRoutes from './routes/api/search.js';
import bundleApiRoutes from './routes/api/bundles.js';
import oauthRoutes from './routes/auth/oauth.js';

async function main() {
  const app = Fastify({
    logger: {
      level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
      transport: process.env.NODE_ENV !== 'production' ? { target: 'pino-pretty' } : undefined,
    },
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
  app.get('/health', async () => ({ status: 'ok', version: '0.1.0' }));

  // OCI Distribution Spec routes
  await app.register(catalogRoutes, { prefix: '/v2' });
  await app.register(blobRoutes, { prefix: '/v2/:namespace/:name' });
  await app.register(manifestRoutes, { prefix: '/v2/:namespace/:name' });
  await app.register(tagRoutes, { prefix: '/v2/:namespace/:name' });

  // Custom API routes
  await app.register(searchApiRoutes, { prefix: '/api/v1' });
  await app.register(bundleApiRoutes, { prefix: '/api/v1' });
  await app.register(oauthRoutes, { prefix: '/api/v1/auth' });

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
}

main();
