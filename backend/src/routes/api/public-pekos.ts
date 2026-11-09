import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { db } from "../../db/index.js";
import { instances, users } from "../../db/schema.js";
import { eq, and, sql, desc, inArray } from "drizzle-orm";
import { z } from "zod";
import { instanceService, type InstanceStatus } from "../../services/instances.js";
import { WindowLimiter } from "../../services/window-limiter.js";
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

const HistoryQuerySchema = z.object({
  before: z.string().min(1).max(128).optional(),
  after: z.string().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const ChatBodySchema = z.object({
  message: z.string().min(1),
  tos_acknowledged: z.boolean().optional(),
});

export default async function publicPekoRoutes(fastify: FastifyInstance) {
  const publicChatLimiter = new WindowLimiter(20, 60_000);
  // ── Public peko page data ──────────────────────────────────────────────────
  fastify.get("/public/pekos/:owner/:pekoName", async (request, reply) => {
    const { owner, pekoName } = request.params as {
      owner: string;
      pekoName: string;
    };

    // With visitor chat on, set the visitor cookie on first page load
    // so the subsequent POST .../chat can resolve the visitor without a
    // redirect. Setting it is idempotent and keeps the expiry rolling.
    if (fastify.config.ALLOW_VISITOR_CHAT === "true") {
      readOrSetVisitor(request, reply, fastify.config.JWT_SECRET);
    }

    const ownerRow = await db.query.users.findFirst({
      where: eq(users.namespace, owner),
    });
    if (!ownerRow) {
      return reply.status(404).send({ error: "Owner not found" });
    }

    // `@owner/name`, by the same resolver as directory lookup and chat:
    // the newest public peko of that name (hub ADR-009 D3).
    let instance = await instanceService.getByHandle(owner, pekoName);
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
        avatar: instance.avatar,
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
  //
  // For clients with no runtime of their own (a future mobile app). The
  // website and the desktop don't use it: the desktop messages pekos
  // over its own runtime. One SSE stream per message and no Hub-side
  // conversation — a reply produced after the stream closes is lost,
  // and there is no history read yet.
  fastify.post(
    "/public/pekos/:owner/:pekoName/chat",
    async (request, reply) => {
      const { owner, pekoName } = request.params as {
        owner: string;
        pekoName: string;
      };

      if (
        !request.headers.authorization &&
        fastify.config.ALLOW_VISITOR_CHAT !== "true"
      ) {
        return reply
          .status(401)
          .send({ error: "Sign in to message this peko", code: "sign_in_required" });
      }

      // Per-IP cap, stricter than the global one.
      if (!publicChatLimiter.allow(request.ip)) {
        reply.header("Retry-After", publicChatLimiter.retryAfterSeconds);
        return reply.status(429).send({ error: "Too many requests" });
      }

      const ownerRow = await db.query.users.findFirst({
        where: eq(users.namespace, owner),
      });
      if (!ownerRow) {
        return reply.status(404).send({ error: "Owner not found" });
      }

      let instance = await instanceService.getByHandle(owner, pekoName);
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

  // ── History for clients without a runtime (runtime ADR-091 D6) ────────────
  //
  // The signed-in person's own conversation with a peko, one page at a
  // time, read from the peko's host. Never a visitor's; the Hub stores
  // nothing.
  fastify.get(
    "/public/pekos/:owner/:pekoName/history",
    async (request, reply) => {
      const { owner, pekoName } = request.params as { owner: string; pekoName: string };
      let user;
      try {
        user = await fastify.authenticate(request);
      } catch {
        return reply
          .status(401)
          .send({ error: "Sign in to read your conversation", code: "sign_in_required" });
      }
      const query = HistoryQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.status(400).send({ error: "Invalid query", details: query.error.format() });
      }
      let instance = await instanceService.getByHandle(owner, pekoName);
      if (instance && instance.exposure !== "public") instance = null;
      if (!instance) {
        return reply.status(404).send({ error: "Peko not found" });
      }
      if (instance.status === "offline" || !fastify.tunnelManager.isRuntimeConnected(instance.runtimeId)) {
        return reply
          .status(503)
          .send({ error: "The computer hosting this peko is offline", code: "host_offline" });
      }
      try {
        const answer = await fastify.tunnelRouter.proxyHistory(
          instance.runtimeId,
          instance.id,
          instance.name,
          query.data,
          { kind: "user", id: String(user.id) },
        );
        return reply.status(answer.status).send(answer.body);
      } catch {
        return reply
          .status(503)
          .send({ error: "The computer hosting this peko did not answer", code: "host_offline" });
      }
    },
  );

  // ── List accessible pekos (private discovery) ──────────────────────────────
  //
  // Post-H4: the typed `allowedPrincipals` allow-list is gone. PekoHub
  // can only see private instances where the caller is the resolved
  // owner; remote-runtime ACLs (`PrincipalConfig.permissions`) live on
  // the runtime side and aren't visible here. The hub-side view is
  // owner-only + public-exposure.
  //
  // The caller's own pekos on PekoHub, private and public, wherever they
  // run. Each carries its Hub ID, so an app opens the DM with it directly
  // (a private peko has no public page to resolve), plus the owner's
  // handle and the peko's id on its runtime, so another computer of the
  // owner lists it like a peko of its own; the computer it runs on, as
  // that computer names itself (`runtimeName`); and when that computer
  // last connected (`lastSeenAt`), so an app can say how long a peko has
  // been away and set aside the pekos of computers that never came back.
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
          hubId: instances.hubId,
          localId: instances.localId,
          owner: users.namespace,
          ownerName: users.displayName,
          pekoName: instances.name,
          publicName: instances.publicName,
          description: instances.description,
          avatar: instances.avatar,
          status: instances.status,
          exposure: instances.exposure,
          runtimeName: instances.runtimeDisplayName,
          lastSeenAt: instances.lastSeenAt,
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
            inArray(instances.exposure, ["private", "public"]),
            sql`${instances.ownerSubject} = ${ownerSubjectLiteral}::jsonb`,
          ),
        )
        .orderBy(desc(instances.lastSeenAt));

      return {
        pekos: rows.map((r) => ({
          id: r.id,
          hubId: r.hubId,
          localId: r.localId,
          owner: r.owner,
          ownerName: r.ownerName,
          pekoName: r.pekoName,
          publicName: r.publicName,
          description: r.description,
          avatar: r.avatar,
          status: r.status as InstanceStatus,
          exposure: r.exposure,
          runtimeName: r.runtimeName,
          lastSeenAt: r.lastSeenAt ? new Date(r.lastSeenAt).toISOString() : null,
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
