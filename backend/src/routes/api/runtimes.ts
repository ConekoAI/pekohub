import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../../db/index.js';
import { runtimes } from '../../db/schema.js';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';

const RegisterBodySchema = z.object({
  runtime_did: z.string().min(1).max(255),
  display_name: z.string().max(255).optional(),
});

/**
 * Runtime management API routes.
 */
export default async function runtimeRoutes(fastify: FastifyInstance) {
  // ── Register or update a runtime ───────────────────────────────────────────
  fastify.post('/runtimes/register', { preHandler: [authenticateOrDevBypass] }, async (request, reply) => {
    const user = request.user;
    const body = RegisterBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid request body', details: body.error.format() });
    }

    const { runtime_did, display_name } = body.data;

    // Upsert with ON CONFLICT to eliminate TOCTOU race
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

    // If the row already existed with a different owner, the update silently
    // succeeds but ownerId is unchanged. We must verify ownership post-upsert.
    if (row.ownerId !== user.id) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    return reply.status(200).send(row);
  });

  // ── List my runtimes ───────────────────────────────────────────────────────
  fastify.get('/runtimes', { preHandler: [authenticateOrDevBypass] }, async (request, reply) => {
    const user = request.user;

    const rows = await db
      .select()
      .from(runtimes)
      .where(eq(runtimes.ownerId, user.id))
      .orderBy(sql`${runtimes.lastSeenAt} DESC NULLS LAST`);

    return { runtimes: rows };
  });

  // ── Get a single runtime by DID ────────────────────────────────────────────
  fastify.get('/runtimes/:did', { preHandler: [authenticateOrDevBypass] }, async (request, reply) => {
    const user = request.user;
    const { did } = request.params as { did: string };

    const row = await db.query.runtimes.findFirst({
      where: eq(runtimes.runtimeDid, did),
    });

    if (!row) {
      return reply.status(404).send({ error: 'Runtime not found' });
    }

    if (row.ownerId !== user.id) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    return row;
  });
}

/**
 * Pre-handler that authenticates the user or falls back to dev bypass.
 */
async function authenticateOrDevBypass(request: FastifyRequest, reply: FastifyReply) {
  const fastify = request.server;
  try {
    const user = await fastify.authenticate(request);
    request.user = user;
  } catch {
    if (fastify.config.NODE_ENV === 'development' && fastify.config.ALLOW_DEV_AUTH_BYPASS === 'true') {
      // Dev bypass: create a synthetic user so the route can proceed
      request.user = { id: 0, username: 'dev', role: 'developer' } as any;
    } else {
      return reply.status(401).send({ error: 'Authentication required' });
    }
  }
}
