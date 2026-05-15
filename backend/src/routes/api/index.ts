import type { FastifyInstance } from 'fastify';
import searchRoutes from './search.js';
import bundleRoutes from './bundles.js';

export default async function apiRoutes(fastify: FastifyInstance) {
  await fastify.register(searchRoutes, { prefix: '/api/v1' });
  await fastify.register(bundleRoutes, { prefix: '/api/v1' });
}
