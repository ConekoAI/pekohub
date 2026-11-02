import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { hubGroups, instances } from "../../db/schema.js";
import { groupsOfAccount, publicGroup } from "../../services/groups.js";

/**
 * Registered groups (peko-runtime ADR-092 D5/D6). Groups live on their
 * home runtimes; the Hub knows their IDs, names, owners and homes, and
 * which accounts are in them — never their posts.
 */

const HistoryQuery = z.object({
  before: z.string().min(1).max(128).optional(),
  after: z.string().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export default async function groupRoutes(fastify: FastifyInstance) {
  // A group's page: a public group to anyone, an invite-only one only with
  // a valid invite (its existence isn't revealed otherwise).
  fastify.get("/groups/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { invite } = request.query as { invite?: string };
    const group = await publicGroup(id, invite);
    if (!group) return reply.status(404).send({ error: "Group not found" });
    return {
      ...group,
      homeOnline: fastify.tunnelManager.isRuntimeConnected(group.homeRuntime),
    };
  });

  // The signed-in person's groups (ADR-092 D4).
  fastify.get("/me/groups", async (request, reply) => {
    let user;
    try {
      user = await fastify.authenticate(request);
    } catch {
      return reply.status(401).send({ error: "Sign in to see your groups" });
    }
    return { groups: await groupsOfAccount(String(user.id)) };
  });

  // A page of a group's history for a client without a runtime (ADR-092
  // D3, as runtime ADR-091 D6): the home serves only its members. Proxied
  // in the name of the owning peko, which the home runs.
  fastify.get("/groups/:id/history", async (request, reply) => {
    const { id } = request.params as { id: string };
    let user;
    try {
      user = await fastify.authenticate(request);
    } catch {
      return reply.status(401).send({ error: "Sign in to read your group", code: "sign_in_required" });
    }
    const query = HistoryQuery.safeParse(request.query);
    if (!query.success) return reply.status(400).send({ error: "Invalid query" });
    if (!/^[0-9]+$/.test(id)) return reply.status(404).send({ error: "Group not found" });
    const group = await db.query.hubGroups.findFirst({ where: eq(hubGroups.id, BigInt(id)) });
    if (!group || !group.ownerAddress.startsWith("principal:hub:")) {
      return reply.status(404).send({ error: "Group not found" });
    }
    const owner = await db.query.instances.findFirst({
      where: eq(instances.hubId, group.ownerAddress.slice("principal:hub:".length)),
    });
    if (!owner || !fastify.tunnelManager.isRuntimeConnected(group.homeRuntime)) {
      return reply
        .status(503)
        .send({ error: "The computer hosting this group is offline", code: "host_offline" });
    }
    try {
      const answer = await fastify.tunnelRouter.proxyHistory(
        group.homeRuntime,
        owner.id,
        owner.name,
        { ...query.data, group: group.channelId },
        { kind: "user", id: String(user.id) },
      );
      return reply.status(answer.status).send(answer.body);
    } catch {
      return reply
        .status(503)
        .send({ error: "The computer hosting this group did not answer", code: "host_offline" });
    }
  });
}
