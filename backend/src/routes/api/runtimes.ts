import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { randomBytes } from "node:crypto";
import { db } from "../../db/index.js";
import { runtimes } from "../../db/schema.js";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { verifyDidKeyJws } from "../../services/tunnel-crypto.js";

/**
 * ADR-058 D4 — runtime registration requires proof of possession of
 * the claimed DID's Ed25519 key. Without it, the first registrant to
 * claim a `runtime_did` owned the row and the real key holder got a
 * 403 forever after (DID squatting).
 *
 * Flow:
 *   1. `POST /v1/runtimes/register-challenge` (authenticated) →
 *      `{ nonce, exp, owner }`. The nonce is single-use, ~60s TTL, held in
 *      the in-memory challenge store below (same pattern as the
 *      tunnel handshake nonce in `tunnel-manager.ts`). `owner` is the
 *      authenticated user id, disclosed so the client can sign it
 *      into the PoP payload verbatim.
 *   2. `POST /v1/runtimes/register` with body
 *      `{ runtime_did, display_name?, pop: { nonce, jws } }` where
 *      `jws` is a compact JWS (EdDSA) signed with the claimed DID's
 *      key. The JWS payload is canonical JSON with exactly these
 *      keys, in this order, no whitespace:
 *
 *        {"nonce":"…","runtimeDid":"…","owner":"…","iat":N,"exp":N}
 *
 *      - `nonce`      — the challenge nonce from step 1
 *      - `runtimeDid` — the DID being registered (must match the body)
 *      - `owner`      — the authenticated pekohub user id
 *      - `iat`/`exp`  — unix seconds; must be fresh at verification
 *
 *      (The hub verifies the signature over the embedded payload and
 *      then compares parsed claims; the canonical form above is what
 *      the runtime signs — see peko-runtime ADR-058 D4.)
 */

const RegisterPopSchema = z.object({
  nonce: z.string().min(1).max(255),
  jws: z.string().min(1).max(8192),
});

const RegisterBodySchema = z.object({
  runtime_did: z.string().min(1).max(255),
  display_name: z.string().max(255).optional(),
  pop: RegisterPopSchema,
});

/** Challenge nonce TTL (~60s) and store bound (same LRU-eviction
 *  style as `TunnelManager.lastChallengeByRuntime`). */
const REGISTER_CHALLENGE_TTL_MS = 60_000;
const MAX_TRACKED_REGISTER_CHALLENGES = 4_096;
const REGISTER_CHALLENGE_NONCE_BYTES = 32;
/** Clock-skew leeway for the PoP payload's `iat`. */
const POP_IAT_LEEWAY_SECS = 60;

interface RegisterChallenge {
  expiresAt: number;
}

/**
 * In-memory, per-app challenge store. Single-use: a nonce is deleted
 * the moment it is consumed, so a captured PoP cannot be replayed.
 * A nonce lost on restart simply forces the client to re-request a
 * challenge — registration is rare, so persistence buys nothing.
 */
class RegisterChallengeStore {
  private challenges = new Map<string, RegisterChallenge>();

  issue(): { nonce: string; exp: number } {
    const nonce = randomBytes(REGISTER_CHALLENGE_NONCE_BYTES).toString(
      "base64url",
    );
    const expiresAt = Date.now() + REGISTER_CHALLENGE_TTL_MS;
    // LRU-style bound: evict the oldest entry when full.
    if (this.challenges.size >= MAX_TRACKED_REGISTER_CHALLENGES) {
      const oldest = this.challenges.keys().next().value;
      if (oldest !== undefined) this.challenges.delete(oldest);
    }
    this.challenges.set(nonce, { expiresAt });
    return { nonce, exp: Math.floor(expiresAt / 1000) };
  }

  /** Returns true and consumes the nonce iff it exists and is
   *  unexpired. Expired/unknown nonces are rejected (and pruned). */
  consume(nonce: string): boolean {
    const challenge = this.challenges.get(nonce);
    if (!challenge) return false;
    this.challenges.delete(nonce);
    return challenge.expiresAt > Date.now();
  }
}

/**
 * Verify the registration PoP against the request. Returns an error
 * code string on failure, `null` on success.
 *
 * Order matters for security: the nonce is consumed as soon as it
 * validates (single-use), BEFORE the JWS is checked — a failed JWS
 * burns the nonce so an attacker cannot probe signatures against a
 * live challenge.
 */
async function verifyRegisterPop(
  store: RegisterChallengeStore,
  runtimeDid: string,
  ownerId: string,
  pop: z.infer<typeof RegisterPopSchema>,
): Promise<string | null> {
  if (!store.consume(pop.nonce)) {
    return "invalid_pop_nonce";
  }

  const payload = await verifyDidKeyJws(runtimeDid, pop.jws);
  if (payload === null) {
    // Covers: runtime_did is not a did:key, malformed JWS, or a
    // signature made with the wrong key.
    return "invalid_pop_signature";
  }

  if (
    payload.nonce !== pop.nonce ||
    payload.runtimeDid !== runtimeDid ||
    payload.owner !== ownerId
  ) {
    return "invalid_pop_claims";
  }

  const now = Math.floor(Date.now() / 1000);
  const { iat, exp } = payload;
  if (
    typeof iat !== "number" ||
    typeof exp !== "number" ||
    exp <= now ||
    iat > now + POP_IAT_LEEWAY_SECS
  ) {
    return "invalid_pop_freshness";
  }

  return null;
}

/**
 * Runtime management API routes.
 */
export default async function runtimeRoutes(fastify: FastifyInstance) {
  const challengeStore = new RegisterChallengeStore();

  // ── Issue a registration challenge (ADR-058 D4) ────────────────────────────
  fastify.post(
    "/runtimes/register-challenge",
    { preHandler: [authenticateOrDevBypass] },
    async (request, reply) => {
      const { nonce, exp } = challengeStore.issue();
      // `owner` rides the challenge so the runtime can sign it into
      // the PoP payload verbatim; `verifyRegisterPop` compares it
      // against the authenticated user at register time.
      return reply.status(200).send({ nonce, exp, owner: request.user.id });
    },
  );

  // ── Register or update a runtime ───────────────────────────────────────────
  fastify.post(
    "/runtimes/register",
    { preHandler: [authenticateOrDevBypass] },
    async (request, reply) => {
      const user = request.user;
      const body = RegisterBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply
          .status(400)
          .send({
            error: "Invalid request body",
            details: body.error.format(),
          });
      }

      const { runtime_did, display_name, pop } = body.data;

      // ADR-058 D4: proof of possession of the claimed DID's key.
      const popError = await verifyRegisterPop(
        challengeStore,
        runtime_did,
        user.id,
        pop,
      );
      if (popError !== null) {
        return reply.status(400).send({ error: popError });
      }

      // Ownership check BEFORE any write (ADR-058 post-review fix):
      // the previous upsert-then-403 ordering let a valid-PoP caller
      // who is not the row owner clobber the owner's `displayName`
      // and bump `lastSeenAt` before being rejected. A missing row
      // falls through to the insert below (first registrant with a
      // valid PoP creates it).
      const existing = await db
        .select({ ownerId: runtimes.ownerId })
        .from(runtimes)
        .where(eq(runtimes.runtimeDid, runtime_did))
        .limit(1);
      if (existing.length > 0 && existing[0].ownerId !== user.id) {
        return reply.status(403).send({ error: "Forbidden" });
      }

      // Upsert with ON CONFLICT to eliminate TOCTOU race between the
      // check above and this write (a concurrent re-registrant with a
      // different owner still cannot take the row: the update set
      // below never touches ownerId).
      const [row] = await db
        .insert(runtimes)
        .values({
          runtimeDid: runtime_did,
          ownerId: user.id,
          displayName: display_name ?? null,
          lastSeenAt: new Date(),
        })
        .onConflictDoUpdate({
          target: runtimes.runtimeDid,
          set: {
            displayName: display_name ?? sql`EXCLUDED.display_name`,
            lastSeenAt: new Date(),
          },
        })
        .returning();

      // Defense in depth: re-verify ownership post-upsert in case a
      // concurrent transaction changed the row between check and
      // write.
      if (row.ownerId !== user.id) {
        return reply.status(403).send({ error: "Forbidden" });
      }

      return reply.status(200).send(row);
    },
  );

  // ── List my runtimes ───────────────────────────────────────────────────────
  fastify.get(
    "/runtimes",
    { preHandler: [authenticateOrDevBypass] },
    async (request, reply) => {
      const user = request.user;

      const rows = await db
        .select()
        .from(runtimes)
        .where(eq(runtimes.ownerId, user.id))
        .orderBy(sql`${runtimes.lastSeenAt} DESC NULLS LAST`);

      return { runtimes: rows };
    },
  );

  // ── Get a single runtime by DID ────────────────────────────────────────────
  fastify.get(
    "/runtimes/:did",
    { preHandler: [authenticateOrDevBypass] },
    async (request, reply) => {
      const user = request.user;
      const { did } = request.params as { did: string };

      const row = await db.query.runtimes.findFirst({
        where: eq(runtimes.runtimeDid, did),
      });

      if (!row) {
        return reply.status(404).send({ error: "Runtime not found" });
      }

      if (row.ownerId !== user.id) {
        return reply.status(403).send({ error: "Forbidden" });
      }

      return row;
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
      // Dev bypass: create a synthetic user so the route can proceed.
      // `id` is the all-zeros UUID (post-H3 — was integer 0).
      request.user = {
        id: "00000000-0000-0000-0000-000000000000",
        username: "dev",
        role: "developer",
      } as any;
    } else {
      return reply.status(401).send({ error: "Authentication required" });
    }
  }
}
