import type { FastifyInstance } from 'fastify';
import { db } from '../../db/index.js';
import { bundles } from '../../db/schema.js';

/**
 * OCI Distribution Spec: Catalog listing
 * GET /v2/_catalog
 */
export default async function catalogRoutes(fastify: FastifyInstance) {
  fastify.get('/_catalog', async (request, reply) => {
    const { n = 100, last } = request.query as { n?: number; last?: string };

    const allBundles = await db.query.bundles.findMany({
      orderBy: (bundles, { asc }) => [asc(bundles.namespace), asc(bundles.name)],
    });

    // Group by namespace for catalog format
    const namespaces = new Set<string>();
    for (const b of allBundles) {
      namespaces.add(b.namespace);
    }

    const repositories: string[] = allBundles.map(
      (b) => `${b.namespace}/${b.name}`
    );

    // Simple pagination
    let startIdx = 0;
    if (last) {
      startIdx = repositories.findIndex((r) => r > last) + 1;
    }
    const paginated = repositories.slice(startIdx, startIdx + n);

    reply.header('Content-Type', 'application/json');
    return {
      repositories: paginated,
    };
  });
}
