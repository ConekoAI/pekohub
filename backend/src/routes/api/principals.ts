import type { FastifyInstance, FastifyRequest } from "fastify";
import { instanceService, type CallerSubject } from "../../services/instances.js";
import { auditService } from "../../services/audit.js";
import { db } from "../../db/index.js";
import { hubPrincipals, users } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { verifyDidKeyJws } from "../../services/tunnel-crypto.js";
import { pekoShareUrl } from "../../services/origins.js";

// ─────────────────────────────────────────────────────────────────────────────
// Principal directory routes (issue #14).
//
// The runtime's cross-runtime `principal_send`
// ([peko-runtime#29](https://github.com/ConekoAI/peko-runtime/issues/29))
// dispatches to a host by first resolving a `TargetSpec` to a concrete
// `runtime_id` + `instance_id` + `principal_did`. This file is the public
// surface for that resolution.
//
// Two endpoints, both auth-gated (a `CallerSubject` — User-kind
// today, with runtime-attested Principal-kind callers as a follow-up
// behind a runtime-issued JWT, gated on peko-runtime#16):
//
//   * `GET /v1/principals/by-hub-id/:hubId`        — Hub actor UUID
//   * `GET /v1/principals/by-handle/:owner/:principal_name` — human-readable
//
// HTTP semantics, per the issue's acceptance criteria:
//
//   - 200 + resolution on a hit (caller passes `subjectCanAccess`).
//   - 404 on a miss (row missing, DID not set, or wrong owner/name).
//   - 403 on a denied (caller fails the gate). Distinct from 404 so
//     legitimate callers can tell "doesn't exist" from "you can't see
//     it" without an oracle.
//   - 400 on a malformed target spec (DID/owner/name that fails the
//     shared Zod schema). 401 on a missing/invalid JWT.
//
// The batch `POST /v1/principals/resolve` is a follow-up per the
// discussion on the issue.
// ─────────────────────────────────────────────────────────────────────────────

const HUB_ID_PARAM = "[\\w:.\\-]{1,512}";
const OWNER_PARAM = "[a-z0-9][a-z0-9_\\-]{0,127}";
// Mirrors peko-runtime's `validate_agent_name`:
//   1-64 chars, ASCII alnum + "-" or "_", no leading/trailing "-",
//   no ".". The "." in the previous regex was a copy-paste artifact
//   and would have allowed a path-traversal spelling. The Zod
//   `PrincipalName` schema (target-spec.ts) is the authoritative
//   validator; this is a cheap URL-level pre-filter.
// (ADR-059: the constant is renamed for the web-facing "peko"
// vocabulary; the matched wire value is unchanged.)
const PEKO_NAME_PARAM = "[A-Za-z0-9][A-Za-z0-9_\\-]{0,63}";

/**
 * Extract the caller's `Principal` from the request. Mirrors the
 * pattern in `routes/api/instances.ts` — JWT or API key only, no
 * inbound header trust. Anonymous traffic is `null`; the resolver
 * handles that as "deny unless exposure is public".
 */
async function extractCallerSubject(
  fastify: FastifyInstance,
  request: FastifyRequest,
): Promise<CallerSubject> {
  const assertion = request.headers.authorization?.match(/^PekoPrincipal ([A-Za-z0-9_.-]+)$/)?.[1];
  if (request.headers.authorization?.startsWith("PekoPrincipal ")) {
    try {
      if (!assertion || assertion.length > 4096) throw new Error("invalid assertion");
      const unverified = JSON.parse(Buffer.from(assertion.split(".")[1], "base64url").toString());
      if (typeof unverified.sub !== "string" || !unverified.sub.startsWith("did:key:")) throw new Error("invalid subject");
      const claims = await verifyDidKeyJws(unverified.sub, assertion);
      const now = Math.floor(Date.now() / 1000);
      if (!claims || claims.sub !== unverified.sub || claims.aud !== "peko-directory-v1" ||
          claims.path !== request.url.split("?")[0] || typeof claims.iat !== "number" || typeof claims.exp !== "number" ||
          claims.iat > now + 30 || claims.exp < now || claims.exp < claims.iat || claims.exp - claims.iat > 60) {
        throw new Error("invalid claims");
      }
      const actor = await db.query.hubPrincipals.findFirst({ where: eq(hubPrincipals.signingDid, claims.sub as string) });
      if (!actor) throw new Error("principal is not registered");
      return { kind: "principal", id: actor.id };
    } catch {
      throw Object.assign(new Error("Invalid principal directory proof"), { statusCode: 401 });
    }
  }
  try {
    const user = await fastify.authenticate(request);
    return { kind: "user", id: String(user.id) };
  } catch {
    return null;
  }
}

export default async function principalDirectoryRoutes(
  fastify: FastifyInstance,
) {
  // ── GET /v1/principals/by-hub-id/:hubId ────────────────────────────────────────────
  fastify.get(
    `/principals/by-hub-id/:hubId(${HUB_ID_PARAM})`,
    async (request, reply) => {
      const { hubId } = request.params as { hubId: string };
      // Cheap shape check up front so a 400 short-circuits before the DB.
      if (!z.string().uuid().safeParse(hubId).success) {
        return reply
          .status(400)
          .send({ error: "Invalid target spec: expected a Hub actor UUID" });
      }

      const caller = await extractCallerSubject(fastify, request);
      const result = await instanceService.resolvePrincipalTarget(
        { kind: "by-hub-id", hubId },
        caller,
      );

      switch (result.status) {
        case "hit":
          return {
            ...result.resolution,
            shareUrl: pekoShareUrl(fastify.config, result.resolution!),
          };
        case "miss":
          return reply.status(404).send({ error: "Principal not found" });
        case "denied":
          return reply.status(403).send({ error: "Forbidden" });
      }
    },
  );

  // ── POST /v1/principals/by-hub-id/:hubId/move ──────────────────────────────
  // ADR-081 D4/D7: approve linking a principal to a runtime. For an online
  // principal only its owner may approve (a move); for one never online,
  // the approver consents to owning it there. Used once, by that runtime's
  // next registration of the principal, within an hour.
  fastify.post(
    `/principals/by-hub-id/:hubId(${HUB_ID_PARAM})/move`,
    async (request, reply) => {
      const { hubId } = request.params as { hubId: string };
      const body = z
        .object({ runtimeId: z.string().min(1).max(255) })
        .safeParse(request.body);
      if (!z.string().uuid().safeParse(hubId).success || !body.success) {
        return reply.status(400).send({ error: "Expected a Hub actor UUID and { runtimeId }" });
      }
      let user;
      try {
        user = await fastify.authenticate(request);
      } catch {
        return reply.status(401).send({ error: "Authentication required" });
      }
      switch (await instanceService.approveMove(hubId, body.data.runtimeId, String(user.id))) {
        case "approved":
          return reply.status(204).send();
        case "miss":
          return reply.status(404).send({ error: "Principal not found" });
        case "denied":
          return reply.status(403).send({ error: "Only the principal's owner can approve a move" });
      }
    },
  );

  // ── POST /v1/principals/by-hub-id/:hubId/transfer ─────────────────────────
  // ADR-081 D4: the Hub's record is an online principal's owner. Only the
  // recorded owner may transfer it, to another PekoHub user — as an offer
  // that account accepts (`…/transfer/accept`); nothing changes before.
  fastify.post(
    `/principals/by-hub-id/:hubId(${HUB_ID_PARAM})/transfer`,
    async (request, reply) => {
      const { hubId } = request.params as { hubId: string };
      // The new owner by account id, or by handle (what a person types).
      const body = z
        .union([z.object({ ownerId: z.string().uuid() }), z.object({ ownerHandle: z.string().min(1).max(128) })])
        .safeParse(request.body);
      if (!z.string().uuid().safeParse(hubId).success || !body.success) {
        return reply.status(400).send({ error: "Expected a Hub actor UUID and { ownerId } or { ownerHandle }" });
      }
      let ownerId: string;
      if ("ownerId" in body.data) {
        ownerId = body.data.ownerId;
      } else {
        const handle = body.data.ownerHandle.replace(/^@/, "").toLowerCase();
        const target = await db.query.users.findFirst({ where: eq(users.namespace, handle) });
        if (!target) return reply.status(422).send({ error: `No PekoHub user is called @${handle}` });
        ownerId = target.id;
      }
      let user;
      try {
        user = await fastify.authenticate(request);
      } catch {
        return reply.status(401).send({ error: "Authentication required" });
      }
      const result = await instanceService.offerTransfer(hubId, ownerId, String(user.id));
      switch (result.status) {
        case "offered": {
          await auditService.logPrincipalOwnerTransfer(hubId, String(user.id), {
            offeredTo: ownerId,
            via: "api",
          });
          return reply.status(202).send({ status: "offered", ownerId });
        }
        case "miss":
          return reply.status(404).send({ error: "Principal not found" });
        case "denied":
          return reply.status(403).send({ error: "Only the principal's owner can transfer it" });
        case "same_owner":
          return reply.status(422).send({ error: "You already own it" });
        case "unknown_user":
          return reply.status(422).send({ error: "The new owner is not a PekoHub user" });
      }
    },
  );

  // ── POST /v1/principals/by-hub-id/:hubId/transfer/accept ─────────────────
  // The account a principal was offered to takes it; its runtime is told.
  fastify.post(
    `/principals/by-hub-id/:hubId(${HUB_ID_PARAM})/transfer/accept`,
    async (request, reply) => {
      const { hubId } = request.params as { hubId: string };
      if (!z.string().uuid().safeParse(hubId).success) {
        return reply.status(400).send({ error: "Expected a Hub actor UUID" });
      }
      let user;
      try {
        user = await fastify.authenticate(request);
      } catch {
        return reply.status(401).send({ error: "Authentication required" });
      }
      const result = await instanceService.acceptTransfer(hubId, String(user.id));
      if (result.status !== "transferred") {
        return reply.status(404).send({ error: "No open transfer of this peko to you" });
      }
      await auditService.logPrincipalOwnerTransfer(hubId, String(user.id), {
        from: result.previous,
        to: String(user.id),
        via: "api",
      });
      if (result.localId) {
        fastify.tunnelManager?.notifyOwnerChanged(result.runtimeId, result.localId, hubId, String(user.id));
      }
      return reply.status(204).send();
    },
  );

  // ── DELETE /v1/principals/by-hub-id/:hubId/transfer ──────────────────────
  // The recipient declines, or the owner withdraws, an open offer.
  fastify.delete(
    `/principals/by-hub-id/:hubId(${HUB_ID_PARAM})/transfer`,
    async (request, reply) => {
      const { hubId } = request.params as { hubId: string };
      if (!z.string().uuid().safeParse(hubId).success) {
        return reply.status(400).send({ error: "Expected a Hub actor UUID" });
      }
      let user;
      try {
        user = await fastify.authenticate(request);
      } catch {
        return reply.status(401).send({ error: "Authentication required" });
      }
      if (!(await instanceService.withdrawTransfer(hubId, String(user.id)))) {
        return reply.status(404).send({ error: "No open transfer of this peko" });
      }
      return reply.status(204).send();
    },
  );

  // ── GET /v1/me/transfers ───────────────────────────────────────────────────
  // Open offers to and from the signed-in account.
  fastify.get("/me/transfers", async (request, reply) => {
    let user;
    try {
      user = await fastify.authenticate(request);
    } catch {
      return reply.status(401).send({ error: "Authentication required" });
    }
    return { transfers: await instanceService.transferOffersOf(String(user.id)) };
  });

  // ── GET /v1/principals/by-handle/:owner/:principal_name ──────────────────────────
  fastify.get(
    `/principals/by-handle/:owner(${OWNER_PARAM})/:principal_name(${PEKO_NAME_PARAM})`,
    async (request, reply) => {
      const { owner, principal_name: principalName } = request.params as {
        owner: string;
        principal_name: string;
      };
      if (principalName === "") {
        return reply
          .status(400)
          .send({ error: "Invalid target spec: principal name is required" });
      }

      const caller = await extractCallerSubject(fastify, request);
      const result = await instanceService.resolvePrincipalTarget(
        { kind: "by-handle", owner, principalName },
        caller,
      );

      switch (result.status) {
        case "hit":
          return {
            ...result.resolution,
            shareUrl: pekoShareUrl(fastify.config, result.resolution!),
          };
        case "miss":
          return reply.status(404).send({ error: "Principal not found" });
        case "denied":
          return reply.status(403).send({ error: "Forbidden" });
      }
    },
  );
}
