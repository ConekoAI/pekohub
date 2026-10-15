import type { FastifyInstance, FastifyRequest } from "fastify";
import { instanceService, type CallerSubject } from "../../services/instances.js";
import { db } from "../../db/index.js";
import { hubPrincipals } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { verifyDidKeyJws } from "../../services/tunnel-crypto.js";

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
          return result.resolution;
        case "ambiguous":
          return reply.status(409).send({ error: "Principal handle is ambiguous; use its Hub ID" });
        case "miss":
          return reply.status(404).send({ error: "Principal not found" });
        case "denied":
          return reply.status(403).send({ error: "Forbidden" });
      }
    },
  );

  // ── POST /v1/principals/by-hub-id/:hubId/move ──────────────────────────────
  // ADR-081 D7: the principal's owner approves moving its online link to
  // another runtime. The approval is used once, by that runtime's next
  // registration of the principal, within an hour.
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
          return result.resolution;
        case "ambiguous":
          return reply.status(409).send({ error: "Principal handle is ambiguous; use its Hub ID" });
        case "miss":
          return reply.status(404).send({ error: "Principal not found" });
        case "denied":
          return reply.status(403).send({ error: "Forbidden" });
      }
    },
  );
}
