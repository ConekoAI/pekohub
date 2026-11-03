import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { REPORT_REASONS } from "../../db/schema.js";
import { fileReport } from "../../services/moderation.js";

/**
 * Reports (gap map B2). A signed-in person reports a seed
 * (`owner/name[@version]`), a public peko (`@owner/name`), a person
 * (`@handle`), or a group (its ID); moderators see them at
 * `GET /v1/admin/reports`.
 *
 *   POST /v1/reports  { target, reason, note? }
 */

const ReportBody = z.object({
  target: z.string().min(1).max(512),
  reason: z.enum(REPORT_REASONS),
  note: z.string().max(2000).optional(),
});

export default async function reportRoutes(fastify: FastifyInstance) {
  fastify.post("/reports", async (request, reply) => {
    let user;
    try {
      user = await fastify.authenticate(request);
    } catch {
      return reply.status(401).send({ error: "Sign in to report" });
    }
    const body = ReportBody.safeParse(request.body);
    if (!body.success) {
      return reply
        .status(400)
        .send({ error: `Send { target, reason, note? }; reason is one of ${REPORT_REASONS.join(", ")}` });
    }
    const filed = await fileReport(user, body.data);
    if (!filed.ok) {
      if (filed.status === 429) reply.header("Retry-After", 3600);
      return reply.status(filed.status).send({ error: filed.error });
    }
    const { report, duplicate } = filed;
    return reply.status(duplicate ? 200 : 201).send({
      id: report.id,
      targetKind: report.targetKind,
      target: report.target,
      reason: report.reason,
      status: report.status,
      createdAt: report.createdAt.toISOString(),
      duplicate,
    });
  });
}
