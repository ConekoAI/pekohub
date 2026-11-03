import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  instanceService,
  type CallerSubject,
  type InstanceExposure,
  type InstanceStatus,
  type InstanceType,
} from "../../services/instances.js";
import { isTakenDown } from "../../services/moderation.js";
import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Caller extraction (issue #11, review #12 P1 fix)
//
// The hub identifies who's knocking on an instance endpoint by the
// JWT (or API key) carried in the request — `fastify.authenticate`.
// A previous draft also honoured the inbound `x-pekohub-caller-principal`
// header, but that header travels on the public v1 HTTP API, so
// honouring it without an independent auth proof would have let any
// client spoof `Principal::User("42")` (or any other principal id) and
// gain access. Per the review on PR #12, the safe pattern is:
//
//   - JWT/API-key auth is mandatory.
//   - The header is **only** consulted as a refinement after the user
//     is established; today no caller path needs refinement, so the
//     header is dropped entirely on the inbound side.
//
// Agent-caller support (the issue #11 regression test) will require
// a runtime-issued JWT or signed header, which is its own follow-up.
// The outbound direction (hub → runtime bridge) still sets
// `x-pekohub-caller-principal` in `tunnel-router.ts`'s
// `bridgeHeadersFor` — the runtime-side reader of that header is
// gated on peko-runtime#16.
// ─────────────────────────────────────────────────────────────────────────────

async function extractCallerSubject(
  fastify: FastifyInstance,
  request: FastifyRequest,
): Promise<CallerSubject> {
  try {
    const user = await fastify.authenticate(request);
    return { kind: "user", id: String(user.id) };
  } catch {
    return null;
  }
}

const TAKEN_DOWN = "A PekoHub moderator took this peko off the Hub";

const ListQuerySchema = z.object({
  status: z.enum(["online", "offline", "busy", "error"]).optional(),
  type: z.enum(["principal"]).optional(),
  runtime_id: z.string().optional(),
  page: z.coerce.number().min(1).default(1),
  per_page: z.coerce.number().min(1).max(100).default(20),
});

const UpdateBodySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  runtime_display_name: z.string().max(255).optional(),
  status: z.enum(["online", "offline", "busy", "error"]).optional(),
  exposure: z.enum(["private", "public", "local_only"]).optional(),
  // Post-H4: allowedPrincipals update field is gone.
  metadata: z.record(z.unknown()).optional(),

  // Public profile
  public_name: z.string().max(255).optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  category: z
    .enum([
      "productivity",
      "coding",
      "creative",
      "business",
      "entertainment",
      "education",
      "other",
    ])
    .optional(),
  tos_required: z.boolean().optional(),
  tos_text: z.string().optional(),
  daily_quota: z.coerce.number().int().nonnegative().optional(),
  weekly_quota: z.coerce.number().int().nonnegative().optional(),
});

const UpdateExposureBodySchema = z.object({
  exposure: z.enum(["private", "public", "local_only"]),
  // Post-H4: allowedPrincipals removed from the exposure PATCH
  // request. The runtime owns the ACL surface (R4).
  public_profile: z
    .object({
      public_name: z.string().min(1).max(255),
      description: z.string(),
      tags: z.array(z.string()),
      category: z.enum([
        "productivity",
        "coding",
        "creative",
        "business",
        "entertainment",
        "education",
        "other",
      ]),
      tos_required: z.boolean().optional(),
      tos_text: z.string().optional(),
      daily_quota: z.coerce.number().int().nonnegative().optional(),
      weekly_quota: z.coerce.number().int().nonnegative().optional(),
    })
    .optional(),
});

const UpdateStatusBodySchema = z.object({
  status: z.enum(["online", "offline", "busy", "error"]),
});

const ChatBodySchema = z.object({
  message: z.string().min(1),
  tos_acknowledged: z.boolean().optional(),
});

// PR #11: invite-token mint body. Scope is a free-form string
// array (the runtime's `parse_permission` resolves each to a
// `peko_auth::Permission`). The runtime hard-caps `ttl_secs` at
// 30 days; we accept anything but a 30d max on the hub side as
// well so a misbehaving caller can't blow past it.
const MintInviteBodySchema = z.object({
  scope: z.array(z.string()).default(["chat"]),
  ttl_secs: z
    .number()
    .int()
    .positive()
    .max(30 * 24 * 60 * 60)
    .default(7 * 24 * 60 * 60),
});

/**
 * Instance management API routes.
 */
export default async function instanceRoutes(fastify: FastifyInstance) {
  // ── List my instances ──────────────────────────────────────────────────────
  fastify.get(
    "/instances",
    { preHandler: [authenticateOrDevBypass] },
    async (request, reply) => {
      const user = request.user;
      const query = ListQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply
          .status(400)
          .send({
            error: "Invalid query parameters",
            details: query.error.format(),
          });
      }

      const result = await instanceService.list({
        ownerSubject: { kind: "user", id: String(user.id) },
        status: query.data.status as InstanceStatus | undefined,
        type: query.data.type as InstanceType | undefined,
        runtimeId: query.data.runtime_id,
        page: query.data.page,
        perPage: query.data.per_page,
      });

      return result;
    },
  );

  // ── Get instance details ───────────────────────────────────────────────────
  fastify.get("/instances/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const instance = await instanceService.getById(id);
    if (!instance) {
      return reply.status(404).send({ error: "Instance not found" });
    }

    // Issue #11: caller is a typed Principal, not just a user id.
    // For private/unexposed, the access check itself requires a
    // non-null caller; for public, anonymous is fine.
    const caller = await extractCallerSubject(fastify, request);
    if (
      (instance.exposure === "private" || instance.exposure === "local_only") &&
      caller === null
    ) {
      if (instance.exposure === "private") {
        return reply.status(401).send({ error: "Authentication required" });
      }
      return reply.status(403).send({ error: "Forbidden" });
    }

    if (!(await instanceService.canAccess(instance, caller))) {
      return reply.status(403).send({ error: "Forbidden" });
    }

    const isOwner =
      caller !== null && (await instanceService.isOwner(instance, caller));
    if (!isOwner) {
      // Redact owner-only fields from the public-facing record.
      // ownerSubject is the typed subject (sensitive — leaks the
      // owner's identity) so it joins the redaction list.
      // Post-H4: allowedPrincipals is gone from the record.
      const { ownerSubject, runtimeId, ...rest } = instance;
      return rest;
    }

    return instance;
  });

  // No `POST /instances`: a peko's row is made only by its runtime's
  // announce over the tunnel, which proves the runtime and the peko's key.
  // A row made here could take a peko's ID — runtimes derive it from their
  // DID and the peko's name — and block its registration for good.

  // ── Update instance ────────────────────────────────────────────────────────
  fastify.patch(
    "/instances/:id",
    { preHandler: [authenticateOrDevBypass] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user;

      const instance = await instanceService.getById(id);
      if (!instance) {
        return reply.status(404).send({ error: "Instance not found" });
      }

      if (!(await instanceService.isOwner(instance, user.id))) {
        return reply.status(403).send({ error: "Forbidden" });
      }

      const body = UpdateBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply
          .status(400)
          .send({
            error: "Invalid request body",
            details: body.error.format(),
          });
      }

      if (body.data.exposure && body.data.exposure !== "local_only" && (await isTakenDown(instance.hubId))) {
        return reply.status(403).send({ error: TAKEN_DOWN });
      }
      if (body.data.exposure && body.data.exposure !== "local_only" && !instance.hubId) {
        return reply.status(400).send({error: "Register the principal from its runtime before enabling Hub access"});
      }
      const updated = await instanceService.update(id, {
        name: body.data.name,
        runtimeDisplayName: body.data.runtime_display_name,
        status: body.data.status,
        exposure: body.data.exposure,
        metadata: body.data.metadata,
        publicName: body.data.public_name,
        description: body.data.description,
        tags: body.data.tags,
        category: body.data.category,
        tosRequired: body.data.tos_required,
        tosText: body.data.tos_text,
        dailyQuota: body.data.daily_quota,
        weeklyQuota: body.data.weekly_quota,
      });

      return updated;
    },
  );

  // ── Update exposure (dedicated endpoint with side effects) ─────────────────
  fastify.patch(
    "/instances/:id/exposure",
    { preHandler: [authenticateOrDevBypass] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user;

      const instance = await instanceService.getById(id);
      if (!instance) {
        return reply.status(404).send({ error: "Instance not found" });
      }

      if (!(await instanceService.isOwner(instance, user.id))) {
        return reply.status(403).send({ error: "Forbidden" });
      }

      // Email verification requirement for public exposure
      // TODO: add emailVerified to AuthenticatedUser and enforce strictly
      // if (user.email && !user.emailVerified) {
      //   return reply.status(403).send({ error: 'Email verification required before public exposure' });
      // }

      const body = UpdateExposureBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply
          .status(400)
          .send({
            error: "Invalid request body",
            details: body.error.format(),
          });
      }

      const { exposure, public_profile } = body.data;
      const from = instance.exposure;

      if (exposure !== "local_only" && (await isTakenDown(instance.hubId))) {
        return reply.status(403).send({ error: TAKEN_DOWN });
      }
      if (exposure !== "local_only" && !instance.hubId) {
        return reply.status(400).send({ error: "Register the principal from its runtime before enabling Hub access" });
      }
      // ADR-056 D7: at most one publicly exposed instance per
      // principal DID network-wide. Only enforced when the instance
      // carries a DID — DID-less rows have no network identity to
      // collide on.
      if (
        (exposure === "public") &&
        instance.principalDid
      ) {
        const conflict = await instanceService.findPublicExposureConflict(
          instance.principalDid,
          id,
        );
        if (conflict) {
          return reply.status(409).send({
            error: `Another instance ('${conflict.name}', id ${conflict.id}) is already publicly exposed for this principal DID`,
            conflictingInstanceId: conflict.id,
          });
        }
      }

      const updateInput: Parameters<typeof instanceService.update>[1] = {
        exposure,
      };
      // Post-H4: no allowedPrincipals update — the runtime owns the
      // ACL surface (R4).
      if (exposure === "public" && public_profile) {
        updateInput.publicName = public_profile.public_name;
        updateInput.description = public_profile.description;
        updateInput.tags = public_profile.tags;
        updateInput.category = public_profile.category;
        updateInput.tosRequired = public_profile.tos_required ?? false;
        updateInput.tosText = public_profile.tos_text ?? undefined;
        updateInput.dailyQuota = public_profile.daily_quota ?? undefined;
        updateInput.weeklyQuota = public_profile.weekly_quota ?? undefined;
      }

      const updated = await instanceService.update(id, updateInput);

      let tunnelStatus: "opened" | "already_open" | "closed" = "already_open";
      // Notify runtime via tunnel control channel
      if (fastify.tunnelManager.isRuntimeConnected(instance.runtimeId)) {
        tunnelStatus = "opened";
        // Post-H4: we don't sync an allow-list from pekohub — the
        // runtime owns its own ACL (`PrincipalConfig.permissions`,
        // R4). We only announce the new exposure switch.
        await fastify.tunnelRouter.sendControl(instance.runtimeId, {
          type: "exposure_update",
          payload: {
            instanceId: id,
            exposure,
          },
        });
      } else {
        tunnelStatus = "closed";
      }

      return {
        instance: updated,
        tunnelStatus,
      };
    },
  );

  // ── Update status (dedicated endpoint with side effects) ───────────────────
  fastify.patch(
    "/instances/:id/status",
    { preHandler: [authenticateOrDevBypass] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user;

      const instance = await instanceService.getById(id);
      if (!instance) {
        return reply.status(404).send({ error: "Instance not found" });
      }

      if (!(await instanceService.isOwner(instance, user.id))) {
        return reply.status(403).send({ error: "Forbidden" });
      }

      const body = UpdateStatusBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply
          .status(400)
          .send({
            error: "Invalid request body",
            details: body.error.format(),
          });
      }

      const { status } = body.data;

      const updated = await instanceService.update(id, { status });

      // Notify runtime via tunnel control channel
      let tunnelStatus: "opened" | "already_open" | "closed" = "already_open";
      if (fastify.tunnelManager.isRuntimeConnected(instance.runtimeId)) {
        tunnelStatus = "opened";
        await fastify.tunnelRouter.sendControl(instance.runtimeId, {
          type: "status_update",
          payload: {
            instanceId: id,
            status,
          },
        });
      } else {
        tunnelStatus = "closed";
      }

      return {
        instance: updated,
        tunnelStatus,
      };
    },
  );

  // ── Deregister instance ────────────────────────────────────────────────────
  fastify.delete(
    "/instances/:id",
    { preHandler: [authenticateOrDevBypass] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user;

      const instance = await instanceService.getById(id);
      if (!instance) {
        return reply.status(404).send({ error: "Instance not found" });
      }

      if (!(await instanceService.isOwner(instance, user.id))) {
        return reply.status(403).send({ error: "Forbidden" });
      }

      await instanceService.delete(id);

      return reply.status(204).send();
    },
  );

  // ── Chat proxy (SSE streaming) ─────────────────────────────────────────────
  fastify.post("/instances/:id/chat", async (request, reply) => {
    const { id } = request.params as { id: string };
    const instance = await instanceService.getById(id);
    if (!instance) {
      return reply.status(404).send({ error: "Instance not found" });
    }

    // Issue #11: caller resolution — JWT user OR runtime-attested
    // principal via `x-pekohub-caller-principal`. For private/unexposed
    // exposure the access check itself requires a non-null caller, so
    // a missing header + missing JWT is handled by the 403 path below.
    const caller = await extractCallerSubject(fastify, request);
    if (
      (instance.exposure === "private" ||
        instance.exposure === "local_only") &&
      caller === null
    ) {
      return reply.status(401).send({ error: "Authentication required" });
    }
    if (!(await instanceService.canChat(instance, caller))) {
      if (instance.status === "offline" || instance.exposure === "local_only") {
        return reply.status(503).send({ error: "Service Unavailable" });
      }
      return reply.status(403).send({ error: "Forbidden" });
    }

    const body = ChatBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply
        .status(400)
        .send({ error: "Invalid request body", details: body.error.format() });
    }

    // ToS check for public-facing instances
    if (
      (instance.exposure === "public") &&
      instance.tosRequired &&
      !body.data.tos_acknowledged
    ) {
      return reply
        .status(428)
        .send({
          error: "Terms of Service acknowledgment required",
          tosText: instance.tosText,
        });
    }

    // Proxy through tunnel as an SSE stream
    await fastify.tunnelRouter.proxyStream(
      instance.runtimeId,
      id,
      instance.name,
      body.data,
      { "content-type": "application/json" },
      reply,
      caller,
      null, // no visitor cookie on authenticated path
      { daily: instance.dailyQuota, weekly: instance.weeklyQuota },
    );
  });

  // ── Stream proxy (SSE) ─────────────────────────────────────────────────────
  fastify.get("/instances/:id/stream", async (request, reply) => {
    const { id } = request.params as { id: string };
    const instance = await instanceService.getById(id);
    if (!instance) {
      return reply.status(404).send({ error: "Instance not found" });
    }

    const caller = await extractCallerSubject(fastify, request);
    if (
      (instance.exposure === "private" || instance.exposure === "local_only") &&
      caller === null
    ) {
      return reply.status(401).send({ error: "Authentication required" });
    }
    if (!(await instanceService.canChat(instance, caller))) {
      if (instance.status === "offline" || instance.exposure === "local_only") {
        return reply.status(503).send({ error: "Service Unavailable" });
      }
      return reply.status(403).send({ error: "Forbidden" });
    }

    // Proxy through tunnel as an SSE stream
    try {
      return await fastify.tunnelRouter.proxyStream(
        instance.runtimeId,
        id,
        instance.name,
        {},
        { "content-type": "application/json" },
        reply,
        caller,
        null,
        { daily: instance.dailyQuota, weekly: instance.weeklyQuota },
      );
    } catch (err) {
      fastify.log.warn({ err, instanceId: id }, "Stream proxy failed");
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      reply.raw.write(
        `event: error\ndata: ${JSON.stringify({ message: "Instance unreachable" })}\n\n`,
      );
      reply.raw.end();
    }
  });

  // ── Retired: listing, searching and featuring pekos (hub ADR-009 D2) ───────
  // Public pekos are reachable only by their exact ID, `@owner/name`
  // (`GET /v1/public/pekos/:owner/:name`), never enumerated. These paths
  // answer 410 so an older client can say why its list is empty.
  for (const path of [
    "/instances/public",
    "/instances/public/search",
    "/discovery/search",
    "/discovery/feed/:feed",
  ]) {
    fastify.get(path, async (_request, reply) =>
      reply.status(410).send({
        error: "Pekos are not listed. Look one up by its ID, like @alice/ada.",
        code: "pekos_not_listed",
      }),
    );
  }

  // ADR-059: the public peko page + public chat proxy moved to
  // `public-pekos.ts` as `/v1/public/pekos/:owner/:pekoName[/chat]`
  // (clean rename — the old `/v1/public/principals/*` paths 404).

  // ── Mint invite token (PR #11) ────────────────────────────────────────────
  // Owner-only. The hub is a thin proxy: it relays the request
  // through the runtime's tunnel and surfaces the signed token +
  // share URL in the response. The hub does NOT persist the
  // token — the runtime's in-memory `InviteRevocationSet` is the
  // source of truth for "is this jti burned?".
  fastify.post(
    "/instances/:id/invites",
    { preHandler: [authenticateOrDevBypass] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user;

      const instance = await instanceService.getById(id);
      if (!instance) {
        return reply.status(404).send({ error: "Instance not found" });
      }
      if (!(await instanceService.isOwner(instance, user.id))) {
        return reply.status(403).send({ error: "Forbidden" });
      }

      const body = MintInviteBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply
          .status(400)
          .send({ error: "Invalid request body", details: body.error.format() });
      }

      if (!fastify.tunnelManager.isRuntimeConnected(instance.runtimeId)) {
        return reply.status(502).send({ error: "Runtime not connected" });
      }

      try {
        const minted = await fastify.tunnelManager.requestInviteMint(
          instance.runtimeId,
          instance.name,
          body.data.scope,
          body.data.ttl_secs,
        );
        return reply.status(200).send(minted);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Mint failed";
        fastify.log.warn(
          { err, instanceId: id, principal: instance.name },
          "Invite mint failed",
        );
        return reply.status(502).send({ error: message });
      }
    },
  );

  // ── Revoke invite token (PR #11) ─────────────────────────────────────────
  // Owner-only. Adds the `jti` to the runtime's in-memory
  // revocation set; the next inbound request presenting that
  // token is rejected.
  fastify.delete(
    "/instances/:id/invites/:jti",
    { preHandler: [authenticateOrDevBypass] },
    async (request, reply) => {
      const { id, jti } = request.params as { id: string; jti: string };
      const user = request.user;

      // Reject obviously-bad JTIs client-side so a typo doesn't
      // round-trip the runtime and spam the revocation set.
      // UUIDv4 is the only shape the runtime mints.
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          jti,
        )
      ) {
        return reply.status(400).send({ error: "Invalid jti" });
      }

      const instance = await instanceService.getById(id);
      if (!instance) {
        return reply.status(404).send({ error: "Instance not found" });
      }
      if (!(await instanceService.isOwner(instance, user.id))) {
        return reply.status(403).send({ error: "Forbidden" });
      }

      if (!fastify.tunnelManager.isRuntimeConnected(instance.runtimeId)) {
        return reply.status(502).send({ error: "Runtime not connected" });
      }

      try {
        await fastify.tunnelManager.requestInviteRevoke(
          instance.runtimeId,
          instance.name,
          jti,
        );
        return reply.status(200).send({ jti });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Revoke failed";
        fastify.log.warn(
          { err, instanceId: id, principal: instance.name, jti },
          "Invite revoke failed",
        );
        return reply.status(502).send({ error: message });
      }
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
    if (
      fastify.config.NODE_ENV === "development" &&
      fastify.config.ALLOW_DEV_AUTH_BYPASS === "true"
    ) {
      // Dev bypass not supported for instances (requires real user id)
      return reply.status(401).send({ error: "Authentication required" });
    } else {
      return reply.status(401).send({ error: "Authentication required" });
    }
  }
}
