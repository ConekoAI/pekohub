import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { db } from "../../db/index.js";
import { instances, users } from "../../db/schema.js";
import { eq, and, sql, desc, inArray } from "drizzle-orm";
import { z } from "zod";
import { instanceService, AmbiguousPrincipalReference, type InstanceStatus } from "../../services/instances.js";
import { readOrSetVisitor } from "../../services/visitor-cookie.js";

// ─────────────────────────────────────────────────────────────────────────────
// Public peko endpoints (ADR-059).
//
// Web-facing rename from the retired `/v1/public/principals/*` surface —
// this is a clean rename with NO aliases: the old paths 404. Machine/wire
// names stay "principal" everywhere else (tunnel protocol, /v1/principals
// directory, OCI annotations, DB columns); only these browser-facing routes
// and their user-facing copy say "peko".
// ─────────────────────────────────────────────────────────────────────────────

const ChatBodySchema = z.object({
  message: z.string().min(1),
  tos_acknowledged: z.boolean().optional(),
});

export default async function publicPekoRoutes(fastify: FastifyInstance) {
  // ── Public peko page data ──────────────────────────────────────────────────
  fastify.get("/public/pekos/:owner/:pekoName", async (request, reply) => {
    const { owner, pekoName } = request.params as {
      owner: string;
      pekoName: string;
    };

    // PR-B1: ensure the visitor cookie is set on first page load
    // so the subsequent POST .../chat can resolve the visitor
    // without round-tripping through a redirect. `getOrMintVisitorId`
    // returns the existing or newly-minted id; we set the cookie
    // unconditionally because that's idempotent and keeps the
    // expiry rolling.
    readOrSetVisitor(request, reply, fastify.config.JWT_SECRET);

    const ownerRow = await db.query.users.findFirst({
      where: eq(users.namespace, owner),
    });
    if (!ownerRow) {
      return reply.status(404).send({ error: "Owner not found" });
    }

    // Use the same owner/name resolver as directory lookup and chat.
    let instance;
    try { instance = await instanceService.getByHandle(owner, pekoName); }
    catch (error) {
      if (error instanceof AmbiguousPrincipalReference) return reply.status(409).send({ error: error.message });
      throw error;
    }
    if (instance && instance.exposure !== "public") instance = null;

    if (!instance) {
      return reply.status(404).send({ error: "Peko not found" });
    }

    return {
      liveInstance: {
        id: instance.id,
        localId: instance.localId,
        hubId: instance.hubId,
        publicName: instance.publicName ?? instance.name,
        description: instance.description,
        owner: {
          id: ownerRow.id,
          name: ownerRow.displayName ?? ownerRow.namespace,
          avatarUrl: ownerRow.avatarUrl,
        },
        capabilities: (instance.capabilities as string[]) ?? [],
        status: instance.status,
        tosRequired: instance.tosRequired ?? false,
        tosText: instance.tosText,
      },
    };
  });

  // ── Public chat proxy ──────────────────────────────────────────────────────
  fastify.post(
    "/public/pekos/:owner/:pekoName/chat",
    async (request, reply) => {
      const { owner, pekoName } = request.params as {
        owner: string;
        pekoName: string;
      };

      // IP-based rate limiting for anonymous public access
      const rateLimitKey = `public_chat:${request.ip}`;
      const now = Date.now();
      const windowMs = 60_000;
      const max = 20; // stricter than authenticated
      const store =
        (fastify as any)._publicChatRateLimitStore ??
        new Map<string, number[]>();
      (fastify as any)._publicChatRateLimitStore = store;

      const timestamps = store.get(rateLimitKey) ?? [];
      const valid = timestamps.filter((t: number) => now - t < windowMs);
      if (valid.length >= max) {
        reply.header("Retry-After", Math.ceil(windowMs / 1000));
        return reply.status(429).send({ error: "Too many requests" });
      }
      valid.push(now);
      store.set(rateLimitKey, valid);

      const ownerRow = await db.query.users.findFirst({
        where: eq(users.namespace, owner),
      });
      if (!ownerRow) {
        return reply.status(404).send({ error: "Owner not found" });
      }

      let instance;
      try { instance = await instanceService.getByHandle(owner, pekoName); }
      catch (error) {
        if (error instanceof AmbiguousPrincipalReference) return reply.status(409).send({ error: error.message });
        throw error;
      }
      if (instance && instance.exposure !== "public") instance = null;

      if (!instance) {
        return reply.status(404).send({ error: "Peko not found" });
      }

      // Status check
      if (instance.status === "offline") {
        return reply.status(503).send({ error: "Service Unavailable" });
      }

      const body = ChatBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply
          .status(400)
          .send({
            error: "Invalid request body",
            details: body.error.format(),
          });
      }

      // ToS check
      if (instance.tosRequired && !body.data.tos_acknowledged) {
        return reply
          .status(428)
          .send({
            error: "Terms of Service acknowledgment required",
            tosText: instance.tosText,
          });
      }

      // PR-B1: mint or refresh the visitor cookie so the runtime
      // can resolve this anonymous caller's `Subject` (the visitor
      // UUID round-trips via `x-pekohub-user-id`). Without this,
      // `resolve_bridge_caller` returns NoCaller and the runtime
      // rejects the proxied request with 403 — the historical
      // blocker that prevented anonymous public chat from ever
      // reaching the principal.
      let caller: { kind: "user"; id: string } | null = null;
      if (request.headers.authorization) {
        try {
          const user = await fastify.authenticate(request);
          caller = { kind: "user", id: user.id };
        } catch {
          return reply.status(401).send({ error: "Invalid authorization" });
        }
      }
      const visitorId = caller === null
        ? readOrSetVisitor(request, reply, fastify.config.JWT_SECRET)
        : null;

      // Proxy through tunnel as an SSE stream
      await fastify.tunnelRouter.proxyStream(
        instance.runtimeId,
        instance.id,
        instance.name,
        body.data,
        { "content-type": "application/json" },
        reply,
        caller, // authenticated account or explicit anonymous visitor
        visitorId,
        { daily: instance.dailyQuota, weekly: instance.weeklyQuota },
      );
    },
  );

  // ── List accessible pekos (private discovery) ──────────────────────────────
  //
  // Post-H4: the typed `allowedPrincipals` allow-list is gone. PekoHub
  // can only see private instances where the caller is the resolved
  // owner; remote-runtime ACLs (`PrincipalConfig.permissions`) live on
  // the runtime side and aren't visible here. The hub-side view is
  // owner-only + public-exposure.
  fastify.get(
    "/me/accessible-pekos",
    { preHandler: [authenticateOrDevBypass] },
    async (request, reply) => {
      const user = request.user;

      const ownerSubjectLiteral = JSON.stringify({
        kind: "user",
        id: String(user.id),
      });

      const rows = await db
        .select({
          id: instances.id,
          ownerName: users.displayName,
          pekoName: instances.name,
          publicName: instances.publicName,
          status: instances.status,
        })
        .from(instances)
        // Post-H1: instances are joined to users via the typed
        // `owner_subject` JSONB column, not a numeric FK. We match
        // exact JSONB equality on the user-owned subset.
        .innerJoin(
          users,
          sql`${users.id}::text = ${instances.ownerSubject}->>'id'`,
        )
        .where(
          and(
            eq(instances.exposure, "private"),
            sql`${instances.ownerSubject} = ${ownerSubjectLiteral}::jsonb`,
          ),
        )
        .orderBy(desc(instances.lastSeenAt));

      return {
        pekos: rows.map((r) => ({
          id: r.id,
          ownerName: r.ownerName,
          pekoName: r.pekoName,
          publicName: r.publicName,
          status: r.status as InstanceStatus,
        })),
      };
    },
  );
}

/**
 * Pre-handler that authenticates the user or falls back to dev bypass.
 */
async function authenticateOrDevBypass(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const fastify = request.server;
  try {
    const user = await fastify.authenticate(request);
    request.user = user;
  } catch {
    // Dev bypass not supported for this surface (requires real user id)
    return reply.status(401).send({ error: "Authentication required" });
  }
}
