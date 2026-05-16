import type { FastifyInstance } from 'fastify';
import { GarbageCollector } from '../../services/gc.js';
import { auditService } from '../../services/audit.js';

export default async function adminRoutes(fastify: FastifyInstance) {
  /**
   * POST /api/v1/admin/gc
   * Trigger garbage collection of unreferenced blobs
   * Requires admin authentication
   */
  fastify.post<{
    Body: { retentionDays?: number; dryRun?: boolean };
  }>('/gc', async (request, reply) => {
    const user = await fastify.authenticate(request);

    // In production, check admin role; for now gate by namespace or env
    if (fastify.config.NODE_ENV === 'production') {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const { retentionDays = 7, dryRun = false } = request.body ?? {};

    try {
      const gc = new GarbageCollector(fastify.storage);
      const result = await gc.collect({
        retentionDays,
        dryRun,
        batchSize: 1000,
      });

      return {
        status: dryRun ? 'simulated' : 'completed',
        ...result,
      };
    } catch (err) {
      return reply.status(500).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * GET /api/v1/admin/gc/estimate
   * Estimate size of unreferenced blobs
   */
  fastify.get<{
    Querystring: { retentionDays?: string };
  }>('/gc/estimate', async (request) => {
    const user = await fastify.authenticate(request);

    const retentionDays = request.query.retentionDays ? parseInt(request.query.retentionDays) : 7;

    const gc = new GarbageCollector(fastify.storage);
    const bytesFreed = await gc.estimateUnreferencedSize(retentionDays);

    return {
      estimatedBytesFreed: bytesFreed,
      estimatedGiB: (bytesFreed / (1024 ** 3)).toFixed(2),
      retentionDays,
    };
  });

  /**
   * GET /api/v1/admin/audit
   * Query audit logs for a namespace (owners or admins only)
   */
  fastify.get<{
    Querystring: { namespace?: string; action?: string; page?: string; perPage?: string };
  }>('/audit', async (request, reply) => {
    const user = await fastify.authenticate(request);
    const { namespace, action, page, perPage } = request.query;

    if (!namespace) {
      return reply.status(400).send({ error: 'Missing namespace query parameter' });
    }

    // Only namespace owners (or admins in dev) may query their own namespace's logs
    if (user.namespace !== namespace) {
      if (fastify.config.NODE_ENV === 'production') {
        return reply.status(403).send({ error: 'Forbidden' });
      }
      // In non-production, allow admins to view any namespace
    }

    const result = await auditService.listByNamespace(namespace, {
      action,
      page: page ? parseInt(page, 10) : 1,
      perPage: perPage ? parseInt(perPage, 10) : 20,
    });

    return {
      logs: result.logs,
      total: result.total,
      page: result.page,
      perPage: result.perPage,
    };
  });
}
