import type { FastifyInstance } from 'fastify';
import catalogRoutes from './catalog.js';
import blobRoutes from './blobs.js';
import manifestRoutes from './manifests.js';
import tagRoutes from './tags.js';

export default async function ociRoutes(fastify: FastifyInstance) {
  // Catalog is at /v2/_catalog
  await fastify.register(catalogRoutes, { prefix: '/v2' });

  // Blobs, manifests, tags are at /v2/:namespace/:name/...
  // We need to register them in a way that Fastify's encapsulation
  // doesn't break the route matching. Each plugin gets its own prefix.
  await fastify.register(async (app) => {
    await app.register(blobRoutes);
    await app.register(manifestRoutes);
    await app.register(tagRoutes);
  }, { prefix: '/v2/:namespace/:name' });
}
