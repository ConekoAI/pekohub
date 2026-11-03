import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { webOrigin } from "../../services/origins.js";
import { listNotifications, markRead } from "../../services/notifications.js";

/**
 * The signed-in account's notifications — the website's bell and Peko
 * desktop read the same list (the Hub sends no email).
 *
 *   GET  /v1/me/notifications?limit=50   { unread, notifications: [...] }
 *   POST /v1/me/notifications/read       { ids? } — all when omitted
 */
export default async function notificationRoutes(fastify: FastifyInstance) {
  fastify.get("/me/notifications", async (request, reply) => {
    const user = await fastify.authenticate(request);
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(100).default(50) })
      .safeParse(request.query);
    if (!query.success) return reply.status(400).send({ error: "limit is 1–100" });
    const { rows, unread } = await listNotifications(user.id, query.data.limit);
    const origin = webOrigin(fastify.config);
    reply.header("Cache-Control", "no-store");
    return {
      unread,
      notifications: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        text: row.text,
        // The website page that acts on it: `path` for the website, `url` to open from an app.
        path: row.path,
        url: row.path ? `${origin}${row.path}` : null,
        createdAt: row.createdAt.toISOString(),
        readAt: row.readAt?.toISOString() ?? null,
      })),
    };
  });

  fastify.post("/me/notifications/read", async (request, reply) => {
    const user = await fastify.authenticate(request);
    const body = z
      .object({ ids: z.array(z.string().uuid()).max(200).optional() })
      .safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "Send { ids? }: notification IDs" });
    return { marked: await markRead(user.id, body.data.ids) };
  });
}
