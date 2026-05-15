import type { FastifyInstance } from 'fastify';
import { db } from '../../db/index.js';
import { bundles, bundleVersions, pullStats } from '../../db/schema.js';
import { eq, and, sql } from 'drizzle-orm';
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
    });

    if (!bundle) {
      return reply.status(404).send({ error: 'Bundle not found' });
    }

    // Fetch versions separately
    const versions = await db.query.bundleVersions.findMany({
      where: eq(bundleVersions.bundleId, bundle.id),
      orderBy: (v, { desc }) => [desc(v.createdAt)],
    });

    const latestVersion = versions[0];

    // Aggregate pull stats
    const stats = await db.select({
      daily: sql<number>`COALESCE(SUM(CASE WHEN ${pullStats.date} >= NOW() - INTERVAL '1 day' THEN ${pullStats.count} ELSE 0 END), 0)`,
      weekly: sql<number>`COALESCE(SUM(CASE WHEN ${pullStats.date} >= NOW() - INTERVAL '7 days' THEN ${pullStats.count} ELSE 0 END), 0)`,
      monthly: sql<number>`COALESCE(SUM(CASE WHEN ${pullStats.date} >= NOW() - INTERVAL '30 days' THEN ${pullStats.count} ELSE 0 END), 0)`,
      allTime: sql<number>`COALESCE(SUM(${pullStats.count}), 0)`,
    }).from(pullStats).where(eq(pullStats.bundleId, bundle.id));

    const pullCounts = stats[0] ?? { daily: 0, weekly: 0, monthly: 0, allTime: bundle.pullCount };

    const detail = BundleDetail.parse({
      namespace: bundle.namespace,
      name: bundle.name,
      versions: versions.map((v) => ({
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
        deprecated: false,
      },
      readme: bundle.readme,
      pullCount: {
        daily: Number(pullCounts.daily),
        weekly: Number(pullCounts.weekly),
        monthly: Number(pullCounts.monthly),
        allTime: Number(pullCounts.allTime),
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
    });

    if (!bundle) {
      return reply.status(404).send({ error: 'Bundle not found' });
    }

    const versions = await db.query.bundleVersions.findMany({
      where: eq(bundleVersions.bundleId, bundle.id),
      orderBy: (v, { desc }) => [desc(v.createdAt)],
    });

    return {
      namespace: bundle.namespace,
      name: bundle.name,
      versions: versions.map((v) => ({
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
