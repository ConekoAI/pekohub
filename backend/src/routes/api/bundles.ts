import type { FastifyInstance } from 'fastify';
import { db } from '../../db/index.js';
import { bundles, bundleVersions } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { BundleDetail } from '@pekohub/shared';

/**
 * Custom API: Bundle metadata and detail pages
 * GET /api/v1/bundles/:namespace/:name
 * GET /api/v1/bundles/:namespace/:name/versions
 */
export default async function bundleRoutes(fastify: FastifyInstance) {
  // GET bundle detail
  fastify.get('/bundles/:namespace/:name', async (request, reply) => {
    const { namespace, name } = request.params as { namespace: string; name: string };

    const bundle = await db.query.bundles.findFirst({
      where: and(eq(bundles.namespace, namespace), eq(bundles.name, name)),
      with: {
        versions: true,
      },
    });

    if (!bundle) {
      return reply.status(404).send({ error: 'Bundle not found' });
    }

    const latestVersion = bundle.versions[bundle.versions.length - 1];

    const detail = BundleDetail.parse({
      namespace: bundle.namespace,
      name: bundle.name,
      versions: bundle.versions.map((v) => ({
        version: v.version,
        digest: v.digest,
        size: v.size,
        createdAt: v.createdAt.toISOString(),
        deprecated: v.deprecated,
        deprecatedMessage: v.deprecatedMessage,
      })),
      metadata: {
        name: bundle.name,
        description: bundle.description,
        author: bundle.author,
        license: bundle.license,
        tags: bundle.tags ?? [],
        categories: bundle.categories ?? [],
        bundleType: bundle.bundleType,
        extensionType: bundle.extensionType,
        modelProviders: bundle.modelProviders ?? [],
        requiredMcpServers: bundle.requiredMcpServers ?? [],
        homepage: bundle.homepage,
        repository: bundle.repository,
        readme: bundle.readme,
        version: latestVersion?.version ?? '0.0.0',
      },
      readme: bundle.readme,
      pullCount: {
        daily: 0, // TODO: aggregate from pullStats
        weekly: 0,
        monthly: 0,
        allTime: bundle.pullCount,
      },
      installCommand: `peko agent install ${namespace}/${name}:${latestVersion?.version ?? 'latest'}`,
    });

    return detail;
  });

  // GET version history
  fastify.get('/bundles/:namespace/:name/versions', async (request, reply) => {
    const { namespace, name } = request.params as { namespace: string; name: string };

    const bundle = await db.query.bundles.findFirst({
      where: and(eq(bundles.namespace, namespace), eq(bundles.name, name)),
      with: {
        versions: true,
      },
    });

    if (!bundle) {
      return reply.status(404).send({ error: 'Bundle not found' });
    }

    return {
      namespace: bundle.namespace,
      name: bundle.name,
      versions: bundle.versions.map((v) => ({
        version: v.version,
        digest: v.digest,
        size: v.size,
        createdAt: v.createdAt.toISOString(),
        deprecated: v.deprecated,
        deprecatedMessage: v.deprecatedMessage,
      })),
    };
  });
}
