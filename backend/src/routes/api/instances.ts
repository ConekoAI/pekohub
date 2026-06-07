import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../../db/index.js';
import { instances } from '../../db/schema.js';
import { instanceService, type InstanceExposure, type InstanceStatus, type InstanceType } from '../../services/instances.js';
import { eq, and, sql, desc, count } from 'drizzle-orm';
import { z } from 'zod';

const ListQuerySchema = z.object({
  status: z.enum(['online', 'offline', 'busy', 'error']).optional(),
  type: z.enum(['agent', 'team']).optional(),
  runtime_id: z.string().optional(),
  page: z.coerce.number().min(1).default(1),
  per_page: z.coerce.number().min(1).max(100).default(20),
});

const CreateBodySchema = z.object({
  id: z.string().uuid().optional(),
  type: z.enum(['agent', 'team']),
  name: z.string().min(1).max(255),
  runtime_id: z.string().min(1).max(255),
  runtime_display_name: z.string().max(255).optional(),
  bundle_ref: z.string().max(255).optional(),
  status: z.enum(['online', 'offline', 'busy', 'error']).optional(),
  exposure: z.enum(['private', 'public', 'unexposed']).optional(),
  allowed_users: z.array(z.string()).optional(),
  capabilities: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const UpdateBodySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  runtime_display_name: z.string().max(255).optional(),
  exposure: z.enum(['private', 'public', 'unexposed']).optional(),
  allowed_users: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const ChatBodySchema = z.object({
  message: z.string().min(1),
});

/**
 * Instance management API routes.
 */
export default async function instanceRoutes(fastify: FastifyInstance) {
  // ── List my instances ──────────────────────────────────────────────────────
  fastify.get('/instances', { preHandler: [authenticateOrDevBypass] }, async (request, reply) => {
    const user = request.user;
    const query = ListQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({ error: 'Invalid query parameters', details: query.error.format() });
    }

    const result = await instanceService.list({
      ownerId: user.id,
      status: query.data.status as InstanceStatus | undefined,
      type: query.data.type as InstanceType | undefined,
      runtimeId: query.data.runtime_id,
      page: query.data.page,
      perPage: query.data.per_page,
    });

    return result;
  });

  // ── Get instance details ───────────────────────────────────────────────────
  fastify.get('/instances/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const instance = await instanceService.getById(id);
    if (!instance) {
      return reply.status(404).send({ error: 'Instance not found' });
    }

    let userId: number | null = null;
    if (instance.exposure === 'private' || instance.exposure === 'unexposed') {
      try {
        const user = await fastify.authenticate(request);
        userId = user.id;
      } catch {
        if (instance.exposure === 'private') {
          return reply.status(401).send({ error: 'Authentication required' });
        }
        // For unexposed, no auth means forbidden
        return reply.status(403).send({ error: 'Forbidden' });
      }
    }

    if (!instanceService.canAccess(instance, userId)) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    return instance;
  });

  // ── Register a new instance ────────────────────────────────────────────────
  fastify.post('/instances', { preHandler: [authenticateOrDevBypass] }, async (request, reply) => {
    const user = request.user;
    const body = CreateBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid request body', details: body.error.format() });
    }

    const instance = await instanceService.create({
      id: body.data.id,
      type: body.data.type,
      name: body.data.name,
      ownerId: user.id,
      runtimeId: body.data.runtime_id,
      runtimeDisplayName: body.data.runtime_display_name,
      bundleRef: body.data.bundle_ref,
      status: body.data.status,
      exposure: body.data.exposure,
      allowedUsers: body.data.allowed_users,
      capabilities: body.data.capabilities,
      metadata: body.data.metadata,
    });

    // Index public instances into search
    if (instance.exposure === 'public') {
      try {
        await fastify.search.indexInstance({
          objectID: instance.id,
          id: instance.id,
          name: instance.name,
          type: instance.type,
          bundleRef: instance.bundleRef ?? undefined,
          status: instance.status,
          capabilities: instance.capabilities,
          ownerId: instance.ownerId,
          runtimeDisplayName: instance.runtimeDisplayName ?? undefined,
          createdAt: instance.createdAt.toISOString(),
        });
      } catch (err) {
        fastify.log.warn({ err }, 'Failed to index instance in Meilisearch');
      }
    }

    return reply.status(201).send(instance);
  });

  // ── Update instance ────────────────────────────────────────────────────────
  fastify.patch('/instances/:id', { preHandler: [authenticateOrDevBypass] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = request.user;

    const instance = await instanceService.getById(id);
    if (!instance) {
      return reply.status(404).send({ error: 'Instance not found' });
    }

    if (instance.ownerId !== user.id) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const body = UpdateBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid request body', details: body.error.format() });
    }

    const updated = await instanceService.update(id, {
      name: body.data.name,
      runtimeDisplayName: body.data.runtime_display_name,
      exposure: body.data.exposure,
      allowedUsers: body.data.allowed_users,
      metadata: body.data.metadata,
    });

    // Sync search index
    try {
      if (updated!.exposure === 'public') {
        await fastify.search.indexInstance({
          objectID: updated!.id,
          id: updated!.id,
          name: updated!.name,
          type: updated!.type,
          bundleRef: updated!.bundleRef ?? undefined,
          status: updated!.status,
          capabilities: updated!.capabilities,
          ownerId: updated!.ownerId,
          runtimeDisplayName: updated!.runtimeDisplayName ?? undefined,
          createdAt: updated!.createdAt.toISOString(),
        });
      } else {
        await fastify.search.deleteInstance(updated!.id);
      }
    } catch (err) {
      fastify.log.warn({ err }, 'Failed to sync instance in Meilisearch');
    }

    return updated;
  });

  // ── Deregister instance ────────────────────────────────────────────────────
  fastify.delete('/instances/:id', { preHandler: [authenticateOrDevBypass] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = request.user;

    const instance = await instanceService.getById(id);
    if (!instance) {
      return reply.status(404).send({ error: 'Instance not found' });
    }

    if (instance.ownerId !== user.id) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    await instanceService.delete(id);

    try {
      await fastify.search.deleteInstance(id);
    } catch (err) {
      fastify.log.warn({ err }, 'Failed to delete instance from Meilisearch');
    }

    return reply.status(204).send();
  });

  // ── Chat proxy ─────────────────────────────────────────────────────────────
  fastify.post('/instances/:id/chat', async (request, reply) => {
    const { id } = request.params as { id: string };
    const instance = await instanceService.getById(id);
    if (!instance) {
      return reply.status(404).send({ error: 'Instance not found' });
    }

    // Auth check
    let userId: number | null = null;
    if (instance.exposure === 'private') {
      try {
        const user = await fastify.authenticate(request);
        userId = user.id;
      } catch {
        return reply.status(401).send({ error: 'Authentication required' });
      }
      if (!instanceService.canAccess(instance, userId)) {
        return reply.status(403).send({ error: 'Forbidden' });
      }
    }

    const body = ChatBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid request body', details: body.error.format() });
    }

    // Proxy through tunnel
    const requestId = crypto.randomUUID();
    try {
      const response = await instanceService.sendProxiedRequest(instance.runtimeId, {
        requestId,
        instanceId: id,
        method: 'chat',
        body: body.data,
        headers: { 'content-type': 'application/json' },
      });

      return reply.status(response.status).send(response.body);
    } catch (err) {
      fastify.log.warn({ err, instanceId: id }, 'Chat proxy failed');
      return reply.status(502).send({ error: 'Instance unreachable' });
    }
  });

  // ── Stream proxy (SSE) ─────────────────────────────────────────────────────
  fastify.get('/instances/:id/stream', async (request, reply) => {
    const { id } = request.params as { id: string };
    const instance = await instanceService.getById(id);
    if (!instance) {
      return reply.status(404).send({ error: 'Instance not found' });
    }

    // Auth check
    let userId: number | null = null;
    if (instance.exposure === 'private') {
      try {
        const user = await fastify.authenticate(request);
        userId = user.id;
      } catch {
        return reply.status(401).send({ error: 'Authentication required' });
      }
      if (!instanceService.canAccess(instance, userId)) {
        return reply.status(403).send({ error: 'Forbidden' });
      }
    }

    // Set up SSE
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const requestId = crypto.randomUUID();

    // TODO: Integrate with tunnel manager to stream chunks.
    // For now, send a placeholder and close.
    reply.raw.write(`data: ${JSON.stringify({ requestId, chunk: '', done: true })}\n\n`);
    reply.raw.end();
  });

  // ── List public instances ──────────────────────────────────────────────────
  fastify.get('/instances/public', async (request, reply) => {
    const query = ListQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({ error: 'Invalid query parameters', details: query.error.format() });
    }

    const result = await instanceService.list({
      exposure: 'public',
      status: query.data.status as InstanceStatus | undefined,
      type: query.data.type as InstanceType | undefined,
      page: query.data.page,
      perPage: query.data.per_page,
    });

    return result;
  });

  // ── Search public instances ────────────────────────────────────────────────
  fastify.get('/instances/public/search', async (request, reply) => {
    const { q, page, per_page } = request.query as Record<string, string>;
    const searchQuery = q ?? '';
    const pageNum = Math.max(1, Number(page ?? 1));
    const perPageNum = Math.min(100, Math.max(1, Number(per_page ?? 20)));

    const result = await fastify.search.searchInstances(searchQuery, {
      page: pageNum - 1,
      hitsPerPage: perPageNum,
    });

    return {
      items: result.hits,
      total: result.total,
      page: result.page,
      perPage: result.perPage,
      totalPages: Math.ceil(result.total / result.perPage),
    };
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
      // Dev bypass not supported for instances (requires real user id)
      return reply.status(401).send({ error: 'Authentication required' });
    } else {
      return reply.status(401).send({ error: 'Authentication required' });
    }
  }
}
