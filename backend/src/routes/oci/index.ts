import type { FastifyInstance } from 'fastify';
import catalogRoutes from './catalog.js';
import blobRoutes from './blobs.js';
import manifestRoutes from './manifests.js';
import tagRoutes from './tags.js';

export default async function ociRoutes(fastify: FastifyInstance) {
  await fastify.register(catalogRoutes, { prefix: '/v2' });
  await fastify.register(blobRoutes, { prefix: '/v2/:namespace/:name' });
  await fastify.register(manifestRoutes, { prefix: '/v2/:namespace/:name' });
  await fastify.register(tagRoutes, { prefix: '/v2/:namespace/:name' });
}
