import type { FastifyInstance } from "fastify";
import { db } from "../../db/index.js";
import { apiKeys } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import crypto from "node:crypto";
import { apiKeyHash } from "../../plugins/auth.js";

/**
 * API Key management
 * POST /api/v1/auth/api-keys      — generate new key
 * GET  /api/v1/auth/api-keys      — list keys (metadata only, no hashes)
 * DELETE /api/v1/auth/api-keys/:id — revoke key
 */
export default async function apiKeyRoutes(fastify: FastifyInstance) {
  // POST /api/v1/auth/api-keys
  fastify.post<{
    Body: { name: string };
  }>("/api-keys", async (request, reply) => {
    const user = await fastify.authenticate(request);
    const { name } = request.body;

    if (!name || name.trim().length === 0) {
      return reply.status(400).send({ error: "Name is required" });
    }

    // Key: `pkr_` + 12 hex (the looked-up prefix, unique) + 24 base64url
    // secret characters — 192 random bits in all, `pkr_` like
    // peko-runtime's own keys (peko-rs/auth/src/api_key.rs). Stored as
    // SHA-256: a random key needs no slow hash, and every authenticated
    // request checks one.
    let record: typeof apiKeys.$inferSelect | undefined;
    let fullKey = "";
    for (let attempt = 1; !record; attempt++) {
      const prefix = "pkr_" + crypto.randomBytes(6).toString("hex");
      fullKey = prefix + crypto.randomBytes(18).toString("base64url");
      try {
        [record] = await db
          .insert(apiKeys)
          .values({ userId: user.id, name: name.trim(), prefix, hash: apiKeyHash(fullKey) })
          .returning();
      } catch (error) {
        // A prefix collision (48 bits) is vanishingly rare; draw again.
        if (attempt >= 3) throw error;
      }
    }

    return reply.status(201).send({
      id: record.id,
      name: record.name,
      prefix: record.prefix,
      key: fullKey, // shown only once
      createdAt: record.createdAt.toISOString(),
    });
  });

  // GET /api/v1/auth/api-keys
  fastify.get("/api-keys", async (request, reply) => {
    const user = await fastify.authenticate(request);

    const keys = await db.query.apiKeys.findMany({
      where: eq(apiKeys.userId, user.id),
      orderBy: (k, { desc }) => [desc(k.createdAt)],
    });

    return {
      keys: keys.map((k) => ({
        id: k.id,
        name: k.name,
        prefix: k.prefix,
        createdAt: k.createdAt.toISOString(),
        lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
      })),
    };
  });

  // DELETE /api/v1/auth/api-keys/:id
  fastify.delete("/api-keys/:id", async (request, reply) => {
    const user = await fastify.authenticate(request);
    const { id } = request.params as { id: string };
    const numericId = Number(id);

    if (!Number.isFinite(numericId)) {
      return reply.status(400).send({ error: "Invalid key ID" });
    }

    const key = await db.query.apiKeys.findFirst({
      where: eq(apiKeys.id, numericId),
    });

    if (!key || key.userId !== user.id) {
      return reply.status(404).send({ error: "Key not found" });
    }

    await db.delete(apiKeys).where(eq(apiKeys.id, numericId));

    return reply.status(204).send();
  });
}
