import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { REPORT_STATUSES, USER_ROLES } from "../../db/schema.js";
import { hasRole } from "../../plugins/auth.js";
import { auditService } from "../../services/audit.js";
import {
  listReports,
  resolveReport,
  setAccountRole,
  setAccountSuspended,
  setPekoTakenDown,
  setSeedHidden,
  setSeedVersionYanked,
  type Result,
} from "../../services/moderation.js";

/**
 * Admin and moderation (gap map B3). Moderators work the report queue and
 * take things down; admins also grant roles and read any audit log.
 *
 *   GET   /v1/admin/audit?namespace=                              own namespace; any for admins
 *   GET   /v1/admin/reports?status=open                           moderator
 *   PATCH /v1/admin/reports/:id               { status, resolution? }
 *   POST  /v1/admin/seeds/:owner/:name/hide   { hidden, reason?, reportId? }
 *   POST  /v1/admin/seeds/:owner/:name/versions/:version/yank { yanked, reason?, reportId? }
 *   POST  /v1/admin/pekos/:hubId/takedown     { takenDown, reason?, reportId? }
 *   POST  /v1/admin/users/:user/suspend       { suspended, reason?, reportId? }
 *   PUT   /v1/admin/users/:user/role          { role }                admin
 *
 * `:user` is an account ID or handle.
 */

const Action = {
  reason: z.string().max(1000).optional(),
  reportId: z.string().uuid().optional(),
};

function send<T>(reply: FastifyReply, result: Result<T>) {
  if (!result.ok) return reply.status(result.status).send({ error: result.error });
  const { ok: _ok, ...body } = result;
  return body;
}

export default async function adminRoutes(fastify: FastifyInstance) {
  /**
   * GET /v1/admin/audit
   * A namespace's audit log: your own, `moderation` for moderators, any for admins.
   */
  fastify.get<{
    Querystring: {
      namespace?: string;
      action?: string;
      page?: string;
      perPage?: string;
    };
  }>("/audit", async (request, reply) => {
    let user;
    try {
      user = await fastify.authenticate(request);
    } catch {
      return reply.status(401).send({ error: "Sign in first" });
    }
    const { namespace, action, page, perPage } = request.query;

    if (!namespace) {
      return reply
        .status(400)
        .send({ error: "Missing namespace query parameter" });
    }

    const allowed =
      user.namespace === namespace ||
      hasRole(user.role, "admin") ||
      (namespace === "moderation" && hasRole(user.role, "moderator"));
    if (!allowed) {
      return reply.status(403).send({ error: "Forbidden" });
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

  // ── Reports ───────────────────────────────────────────────────────────────
  fastify.get("/reports", async (request, reply) => {
    await fastify.requireRole(request, "moderator");
    const query = z
      .object({
        status: z.enum(REPORT_STATUSES).optional(),
        page: z.coerce.number().int().min(1).default(1),
        perPage: z.coerce.number().int().min(1).max(100).default(50),
      })
      .safeParse(request.query);
    if (!query.success) return reply.status(400).send({ error: "Invalid query" });
    return listReports(query.data);
  });

  fastify.patch("/reports/:id", async (request, reply) => {
    const moderator = await fastify.requireRole(request, "moderator");
    const { id } = request.params as { id: string };
    const body = z
      .object({ status: z.enum(REPORT_STATUSES), resolution: z.string().max(1000).optional() })
      .safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "Send { status, resolution? }" });
    if (!z.string().uuid().safeParse(id).success) return reply.status(404).send({ error: "No such report" });
    const result = await resolveReport(moderator, id, body.data.status, body.data.resolution ?? null);
    if (!result.ok) return reply.status(result.status).send({ error: result.error });
    return { id: result.report.id, status: result.report.status };
  });

  // ── Takedowns ─────────────────────────────────────────────────────────────
  fastify.post("/seeds/:owner/:name/hide", async (request, reply) => {
    const moderator = await fastify.requireRole(request, "moderator");
    const { owner, name } = request.params as { owner: string; name: string };
    const body = z.object({ hidden: z.boolean(), ...Action }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "Send { hidden, reason?, reportId? }" });
    const { hidden, ...input } = body.data;
    return send(reply, await setSeedHidden(fastify, moderator, owner, name, hidden, input));
  });

  fastify.post("/seeds/:owner/:name/versions/:version/yank", async (request, reply) => {
    const moderator = await fastify.requireRole(request, "moderator");
    const { owner, name, version } = request.params as { owner: string; name: string; version: string };
    const body = z.object({ yanked: z.boolean(), ...Action }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "Send { yanked, reason?, reportId? }" });
    const { yanked, ...input } = body.data;
    return send(reply, await setSeedVersionYanked(fastify, moderator, owner, name, version, yanked, input));
  });

  fastify.post("/pekos/:hubId/takedown", async (request, reply) => {
    const moderator = await fastify.requireRole(request, "moderator");
    const { hubId } = request.params as { hubId: string };
    const body = z.object({ takenDown: z.boolean(), ...Action }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "Send { takenDown, reason?, reportId? }" });
    const { takenDown, ...input } = body.data;
    return send(reply, await setPekoTakenDown(fastify, moderator, hubId, takenDown, input));
  });

  fastify.post("/users/:user/suspend", async (request, reply) => {
    const moderator = await fastify.requireRole(request, "moderator");
    const { user } = request.params as { user: string };
    const body = z.object({ suspended: z.boolean(), ...Action }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "Send { suspended, reason?, reportId? }" });
    const { suspended, ...input } = body.data;
    return send(reply, await setAccountSuspended(fastify, moderator, user, suspended, input));
  });

  // ── Roles ─────────────────────────────────────────────────────────────────
  fastify.put("/users/:user/role", async (request, reply) => {
    const admin = await fastify.requireRole(request, "admin");
    const { user } = request.params as { user: string };
    const body = z.object({ role: z.enum(USER_ROLES) }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: `Send { role }: ${USER_ROLES.join(", ")}` });
    return send(reply, await setAccountRole(admin, user, body.data.role));
  });
}
