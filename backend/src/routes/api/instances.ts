import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { db } from "../../db/index.js";
import { instances, users } from "../../db/schema.js";
import {
  instanceService,
  type CallerSubject,
  type InstanceExposure,
  type InstanceStatus,
  type InstanceType,
} from "../../services/instances.js";
import { eq, and, sql, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Subject } from "@pekohub/shared";

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

/**
 * Derive the `ownerId` field for the search index from the typed
 * `ownerSubject`. Post-H1 the column is gone; the Meilisearch
 * document keeps an `ownerId` field for filterability (only
 * user-owned instances can be indexed today — principal-owned
 * instances would need a separate index key).
 *
 * Returns `null` when:
 *   - the instance has no owner (`ownerSubject` is null or the empty
 *     sentinel)
 *   - the owner is not a `user` Subject (a Principal-owned instance
 *     gets no `ownerId` in the index)
 *   - the user-id is not a valid UUID (the typed `ownerSubject.id`
 *     is always stored as a JSON string; pre-launch we don't
 *     attempt to coerce non-UUID values — null is the safe default)
 *
 * Post-H3 the `id` is a UUID string and the `indexInstance`
 * signature is `string | null`.
 */
function ownerSubjectUserId(
  ownerSubject: Subject | null | undefined,
): string | null {
  if (!ownerSubject || ownerSubject.kind !== "user") return null;
  // Bare UUID check — the runtime emits UUID strings, the typed
  // owner_subject carries the same shape, and an arbitrary string
  // ("42", "abc") would never match a users.id row.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    ownerSubject.id,
  )
    ? ownerSubject.id
    : null;
}

const ListQuerySchema = z.object({
  status: z.enum(["online", "offline", "busy", "error"]).optional(),
  type: z.enum(["principal"]).optional(),
  runtime_id: z.string().optional(),
  page: z.coerce.number().min(1).default(1),
  per_page: z.coerce.number().min(1).max(100).default(20),
});

const CreateBodySchema = z.object({
  id: z.string().uuid().optional(),
  type: z.enum(["principal"]),
  name: z.string().min(1).max(255),
  runtime_id: z.string().min(1).max(255),
  runtime_display_name: z.string().max(255).optional(),
  bundle_ref: z.string().max(255).optional(),
  status: z.enum(["online", "offline", "busy", "error"]).optional(),
  exposure: z.enum(["private", "public", "unexposed", "unlisted"]).optional(),
  // Post-H4: allowedPrincipals request field is gone. The runtime
  // owns the ACL surface (R4); pekohub only knows the public-vs-
  // private exposure switch.
  capabilities: z.array(z.string()).optional(),
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

const UpdateBodySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  runtime_display_name: z.string().max(255).optional(),
  status: z.enum(["online", "offline", "busy", "error"]).optional(),
  exposure: z.enum(["private", "public", "unexposed", "unlisted"]).optional(),
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
  exposure: z.enum(["private", "public", "unexposed", "unlisted"]),
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
      (instance.exposure === "private" || instance.exposure === "unexposed") &&
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

  // ── Register a new instance ────────────────────────────────────────────────
  fastify.post(
    "/instances",
    { preHandler: [authenticateOrDevBypass] },
    async (request, reply) => {
      const user = request.user;
      const body = CreateBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply
          .status(400)
          .send({
            error: "Invalid request body",
            details: body.error.format(),
          });
      }

      const instance = await instanceService.create({
        id: body.data.id,
        type: body.data.type,
        name: body.data.name,
        ownerSubject: { kind: "user", id: String(user.id) },
        runtimeId: body.data.runtime_id,
        runtimeDisplayName: body.data.runtime_display_name,
        bundleRef: body.data.bundle_ref,
        status: body.data.status,
        exposure: body.data.exposure,
        capabilities: body.data.capabilities,
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

      // Index public instances into search
      if (instance.exposure === "public") {
        try {
          await fastify.search.indexInstance({
            objectID: instance.id,
            id: instance.id,
            name: instance.name,
            type: instance.type,
            bundleRef: instance.bundleRef ?? undefined,
            status: instance.status,
            capabilities: instance.capabilities,
            ownerId: ownerSubjectUserId(instance.ownerSubject),
            runtimeDisplayName: instance.runtimeDisplayName ?? undefined,
            createdAt: instance.createdAt.toISOString(),
            publicName: instance.publicName ?? undefined,
            description: instance.description ?? undefined,
            tags: instance.tags,
            category: instance.category ?? undefined,
            featured: instance.featured,
            publishedAt: instance.publishedAt?.toISOString(),
          });
        } catch (err) {
          fastify.log.warn({ err }, "Failed to index instance in Meilisearch");
        }
      }

      return reply.status(201).send(instance);
    },
  );

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

      // Sync search index
      try {
        if (updated!.exposure === "public") {
          await fastify.search.indexInstance({
            objectID: updated!.id,
            id: updated!.id,
            name: updated!.name,
            type: updated!.type,
            bundleRef: updated!.bundleRef ?? undefined,
            status: updated!.status,
            capabilities: updated!.capabilities,
            ownerId: ownerSubjectUserId(updated!.ownerSubject),
            runtimeDisplayName: updated!.runtimeDisplayName ?? undefined,
            createdAt: updated!.createdAt.toISOString(),
            publicName: updated!.publicName ?? undefined,
            description: updated!.description ?? undefined,
            tags: updated!.tags,
            category: updated!.category ?? undefined,
            featured: updated!.featured,
            publishedAt: updated!.publishedAt?.toISOString(),
          });
        } else {
          await fastify.search.deleteInstance(updated!.id);
        }
      } catch (err) {
        fastify.log.warn({ err }, "Failed to sync instance in Meilisearch");
      }

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

      // Validate transition
      const validTransitions: Record<string, string[]> = {
        unexposed: ["private", "public", "unlisted"],
        private: ["public", "unexposed", "unlisted"],
        public: ["private", "unexposed", "unlisted"],
        unlisted: ["private", "unexposed", "public"],
      };
      if (!validTransitions[from]?.includes(exposure)) {
        return reply
          .status(400)
          .send({
            error: `Invalid exposure transition: ${from} -> ${exposure}`,
          });
      }

      // ADR-056 D7: at most one publicly exposed instance per
      // principal DID network-wide. Only enforced when the instance
      // carries a DID — DID-less rows have no network identity to
      // collide on.
      if (
        (exposure === "public" || exposure === "unlisted") &&
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
        updateInput.publishedAt = new Date();
      }
      if (exposure !== "public") {
        updateInput.publishedAt = null;
      }

      const updated = await instanceService.update(id, updateInput);

      // Side effects: sync search index
      let tunnelStatus: "opened" | "already_open" | "closed" = "already_open";
      try {
        if (updated!.exposure === "public") {
          await fastify.search.indexInstance({
            objectID: updated!.id,
            id: updated!.id,
            name: updated!.name,
            type: updated!.type,
            bundleRef: updated!.bundleRef ?? undefined,
            status: updated!.status,
            capabilities: updated!.capabilities,
            ownerId: ownerSubjectUserId(updated!.ownerSubject),
            runtimeDisplayName: updated!.runtimeDisplayName ?? undefined,
            createdAt: updated!.createdAt.toISOString(),
            publicName: updated!.publicName ?? undefined,
            description: updated!.description ?? undefined,
            tags: updated!.tags,
            category: updated!.category ?? undefined,
            featured: updated!.featured,
            publishedAt: updated!.publishedAt?.toISOString(),
          });
        } else {
          await fastify.search.deleteInstance(updated!.id);
        }
      } catch (err) {
        fastify.log.warn(
          { err },
          "Failed to sync instance in Meilisearch during exposure update",
        );
      }

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

      try {
        await fastify.search.deleteInstance(id);
      } catch (err) {
        fastify.log.warn({ err }, "Failed to delete instance from Meilisearch");
      }

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
        instance.exposure === "unexposed") &&
      caller === null
    ) {
      return reply.status(401).send({ error: "Authentication required" });
    }
    if (!(await instanceService.canChat(instance, caller))) {
      if (instance.status === "offline" || instance.exposure === "unexposed") {
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
      (instance.exposure === "public" || instance.exposure === "unlisted") &&
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
      (instance.exposure === "private" || instance.exposure === "unexposed") &&
      caller === null
    ) {
      return reply.status(401).send({ error: "Authentication required" });
    }
    if (!(await instanceService.canChat(instance, caller))) {
      if (instance.status === "offline" || instance.exposure === "unexposed") {
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

  // ── List public instances ──────────────────────────────────────────────────
  fastify.get("/instances/public", async (request, reply) => {
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
      exposure: "public",
      status: query.data.status as InstanceStatus | undefined,
      type: query.data.type as InstanceType | undefined,
      page: query.data.page,
      perPage: query.data.per_page,
    });

    return result;
  });

  // ── Search public instances ────────────────────────────────────────────────
  fastify.get("/instances/public/search", async (request, reply) => {
    const { q, page, per_page } = request.query as Record<string, string>;
    const searchQuery = q ?? "";
    const pageNum = Math.max(1, Number(page ?? 1));
    const perPageNum = Math.min(100, Math.max(1, Number(per_page ?? 20)));

    const result = await fastify.search.searchInstances(searchQuery, {
      page: pageNum - 1,
      hitsPerPage: perPageNum,
      filter: ["exposure = public"],
    });

    return {
      items: result.hits,
      total: result.total,
      page: result.page,
      perPage: result.perPage,
      totalPages: Math.ceil(result.total / result.perPage),
    };
  });

  // ADR-059: the web-facing "accessible pekos" endpoint moved to
  // `public-pekos.ts` as `GET /v1/me/accessible-pekos` (clean rename —
  // the old `/v1/me/accessible-principals` path 404s).

  // ── Public discovery: search ───────────────────────────────────────────────
  fastify.get("/discovery/search", async (request, reply) => {
    const { q, category, sort, page, per_page } = request.query as Record<
      string,
      string
    >;
    const searchQuery = q ?? "";
    const pageNum = Math.max(1, Number(page ?? 1));
    const perPageNum = Math.min(100, Math.max(1, Number(per_page ?? 20)));

    const meiliFilters: string[] = ["exposure = public"];
    if (category) meiliFilters.push(`category = ${category}`);

    const sortBy: string[] = [];
    if (sort === "trending") {
      // Meilisearch doesn't have native trending; fallback to createdAt desc
      sortBy.push("createdAt:desc");
    } else if (sort === "new") {
      sortBy.push("publishedAt:desc");
    } else if (sort === "featured") {
      meiliFilters.push("featured = true");
      sortBy.push("createdAt:desc");
    } else {
      sortBy.push("createdAt:desc");
    }

    const result = await fastify.search.searchInstances(searchQuery, {
      page: pageNum - 1,
      hitsPerPage: perPageNum,
      filter: meiliFilters,
      sort: sortBy,
    });

    // Hydrate owner info from DB
    const hitIds = result.hits.map((h: any) => h.id as string).filter(Boolean);
    const ownerRows =
      hitIds.length > 0
        ? await db
            .select({
              id: instances.id,
              namespace: users.namespace,
              displayName: users.displayName,
              avatarUrl: users.avatarUrl,
            })
            .from(instances)
            // Post-H1: typed `owner_subject` JSONB. `users.id` cast
            // to text matches `owner_subject->>'id'` for user-owned
            // instances; principal-owned instances drop out via
            // innerJoin.
            .innerJoin(
              users,
              sql`${users.id}::text = ${instances.ownerSubject}->>'id'`,
            )
            .where(inArray(instances.id, hitIds))
        : [];

    const ownerMap = new Map(ownerRows.map((r) => [r.id, r]));

    return {
      hits: result.hits.map((h: any) => {
        const owner = ownerMap.get(h.id);
        return {
          id: h.id,
          publicName: h.publicName ?? h.name,
          description: h.description,
          ownerName: owner?.displayName ?? owner?.namespace ?? "unknown",
          category: h.category,
          tags: h.tags ?? [],
          status: h.status,
          publishedAt: h.publishedAt,
          featured: h.featured ?? false,
        };
      }),
      total: result.total,
      page: result.page,
    };
  });

  // ── Public discovery: curated feeds ────────────────────────────────────────
  fastify.get("/discovery/feed/:feed", async (request, reply) => {
    const { feed } = request.params as { feed: string };
    const { page, per_page } = request.query as Record<string, string>;
    const pageNum = Math.max(1, Number(page ?? 1));
    const perPageNum = Math.min(100, Math.max(1, Number(per_page ?? 20)));

    if (!["trending", "new", "featured"].includes(feed)) {
      return reply
        .status(400)
        .send({
          error: "Invalid feed. Must be one of: trending, new, featured",
        });
    }

    const meiliFilters: string[] = ["exposure = public"];
    const sortBy: string[] = [];

    if (feed === "trending") {
      sortBy.push("createdAt:desc");
    } else if (feed === "new") {
      sortBy.push("publishedAt:desc");
    } else if (feed === "featured") {
      meiliFilters.push("featured = true");
      sortBy.push("createdAt:desc");
    }

    const result = await fastify.search.searchInstances("", {
      page: pageNum - 1,
      hitsPerPage: perPageNum,
      filter: meiliFilters,
      sort: sortBy,
    });

    const hitIds = result.hits.map((h: any) => h.id as string).filter(Boolean);
    const ownerRows =
      hitIds.length > 0
        ? await db
            .select({
              id: instances.id,
              namespace: users.namespace,
              displayName: users.displayName,
              avatarUrl: users.avatarUrl,
            })
            .from(instances)
            // Post-H1: typed `owner_subject` JSONB. `users.id` cast
            // to text matches `owner_subject->>'id'` for user-owned
            // instances; principal-owned instances drop out via
            // innerJoin.
            .innerJoin(
              users,
              sql`${users.id}::text = ${instances.ownerSubject}->>'id'`,
            )
            .where(inArray(instances.id, hitIds))
        : [];

    const ownerMap = new Map(ownerRows.map((r) => [r.id, r]));

    return {
      hits: result.hits.map((h: any) => {
        const owner = ownerMap.get(h.id);
        return {
          id: h.id,
          publicName: h.publicName ?? h.name,
          description: h.description,
          ownerName: owner?.displayName ?? owner?.namespace ?? "unknown",
          category: h.category,
          tags: h.tags ?? [],
          status: h.status,
          publishedAt: h.publishedAt,
          featured: h.featured ?? false,
        };
      }),
      total: result.total,
      page: result.page,
    };
  });

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
