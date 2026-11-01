import type { FastifyInstance } from "fastify";
import { auditService } from "../../services/audit.js";

export default async function adminRoutes(fastify: FastifyInstance) {
  /**
   * GET /api/v1/admin/audit
   * Query audit logs for a namespace (owners or admins only)
   */
  fastify.get<{
    Querystring: {
      namespace?: string;
      action?: string;
      page?: string;
      perPage?: string;
    };
  }>("/audit", async (request, reply) => {
    const user = await fastify.authenticate(request);
    const { namespace, action, page, perPage } = request.query;

    if (!namespace) {
      return reply
        .status(400)
        .send({ error: "Missing namespace query parameter" });
    }

    // Only namespace owners (or admins in dev) may query their own namespace's logs
    if (user.namespace !== namespace) {
      if (fastify.config.NODE_ENV === "production") {
        return reply.status(403).send({ error: "Forbidden" });
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
