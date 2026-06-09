import type { FastifyInstance } from "fastify";
import { db } from "../../db/index.js";
import { apiKeys } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";

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

    // Generate key: ph_<6-char prefix><24-char secret>
    const prefix = "ph_" + crypto.randomBytes(3).toString("hex"); // ph_ + 6 hex = 8 chars total
    const secret = crypto.randomBytes(18).toString("base64url"); // 24 chars
    const fullKey = prefix + secret;

    const hash = await bcrypt.hash(fullKey, 12);

    const [record] = await db
      .insert(apiKeys)
      .values({
        userId: user.id,
        name: name.trim(),
        prefix,
        hash,
      })
      .returning();

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
