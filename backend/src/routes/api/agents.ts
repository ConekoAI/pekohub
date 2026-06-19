import type { FastifyInstance, FastifyRequest } from "fastify";
import { instanceService, type CallerPrincipal } from "../../services/instances.js";

// ─────────────────────────────────────────────────────────────────────────────
// Agent directory routes (issue #14).
//
// The runtime's cross-runtime `a2a_send`
// ([peko-runtime#29](https://github.com/ConekoAI/peko-runtime/issues/29))
// dispatches to a host by first resolving a `TargetSpec` to a concrete
// `runtime_id` + `instance_id` + `agent_did`. This file is the public
// surface for that resolution.
//
// Two endpoints, both auth-gated (a `CallerPrincipal` — User-kind
// today, with runtime-attested Agent-kind callers as a follow-up
// behind a runtime-issued JWT, gated on peko-runtime#16):
//
//   * `GET /v1/agents/by-did/:did`        — DID primary key
//   * `GET /v1/agents/by-handle/:owner/:agent_name` — human-readable
//
// HTTP semantics, per the issue's acceptance criteria:
//
//   - 200 + resolution on a hit (caller passes `principalCanAccess`).
//   - 404 on a miss (row missing, DID not set, or wrong owner/name).
//   - 403 on a denied (caller fails the gate). Distinct from 404 so
//     legitimate callers can tell "doesn't exist" from "you can't see
//     it" without an oracle.
//   - 400 on a malformed target spec (DID/owner/name that fails the
//     shared Zod schema). 401 on a missing/invalid JWT.
//
// The batch `POST /v1/agents/resolve` is a follow-up per the
// discussion on the issue.
// ─────────────────────────────────────────────────────────────────────────────

const DID_PARAM = "[\\w:.\\-]{1,512}";
const OWNER_PARAM = "[a-z0-9][a-z0-9_\\-]{0,127}";
const AGENT_NAME_PARAM = "[A-Za-z0-9][A-Za-z0-9_\\-.]{0,254}";

/**
 * Extract the caller's `Principal` from the request. Mirrors the
 * pattern in `routes/api/instances.ts` — JWT or API key only, no
 * inbound header trust. Anonymous traffic is `null`; the resolver
 * handles that as "deny unless exposure is public".
 */
async function extractCallerPrincipal(
  fastify: FastifyInstance,
  request: FastifyRequest,
): Promise<CallerPrincipal> {
  try {
    const user = await fastify.authenticate(request);
    return { kind: "user", id: String(user.id) };
  } catch {
    return null;
  }
}

export default async function agentDirectoryRoutes(
  fastify: FastifyInstance,
) {
  // ── GET /v1/agents/by-did/:did ────────────────────────────────────────────
  fastify.get(
    `/agents/by-did/:did(${DID_PARAM})`,
    async (request, reply) => {
      const { did } = request.params as { did: string };
      // Cheap shape check up front so a 400 short-circuits before the DB.
      if (!did.startsWith("did:")) {
        return reply
          .status(400)
          .send({ error: "Invalid target spec: expected a `did:...` value" });
      }

      const caller = await extractCallerPrincipal(fastify, request);
      const result = await instanceService.resolveAgentTarget(
        { kind: "by-did", did },
        caller,
      );

      switch (result.status) {
        case "hit":
          return result.resolution;
        case "miss":
          return reply.status(404).send({ error: "Agent not found" });
        case "denied":
          return reply.status(403).send({ error: "Forbidden" });
      }
    },
  );

  // ── GET /v1/agents/by-handle/:owner/:agent_name ──────────────────────────
  fastify.get(
    `/agents/by-handle/:owner(${OWNER_PARAM})/:agent_name(${AGENT_NAME_PARAM})`,
    async (request, reply) => {
      const { owner, agent_name: agentName } = request.params as {
        owner: string;
        agent_name: string;
      };
      if (agentName === "") {
        return reply
          .status(400)
          .send({ error: "Invalid target spec: agent name is required" });
      }

      const caller = await extractCallerPrincipal(fastify, request);
      const result = await instanceService.resolveAgentTarget(
        { kind: "by-handle", owner, agentName },
        caller,
      );

      switch (result.status) {
        case "hit":
          return result.resolution;
        case "miss":
          return reply.status(404).send({ error: "Agent not found" });
        case "denied":
          return reply.status(403).send({ error: "Forbidden" });
      }
    },
  );
}
