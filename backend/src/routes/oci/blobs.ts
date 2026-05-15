import type { FastifyInstance } from 'fastify';
import { db } from '../../db/index.js';
import { blobs } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import crypto from 'node:crypto';

/**
 * OCI Distribution Spec: Blob operations
 * HEAD /v2/{namespace}/{name}/blobs/{digest}
 * GET  /v2/{namespace}/{name}/blobs/{digest}
 * POST /v2/{namespace}/{name}/blobs/uploads/  (initiate upload)
 * PATCH /v2/{namespace}/{name}/blobs/uploads/{uuid}
 * PUT  /v2/{namespace}/{name}/blobs/uploads/{uuid}?digest={digest}
 */
export default async function blobRoutes(fastify: FastifyInstance) {
  // HEAD /v2/{namespace}/{name}/blobs/{digest}
  fastify.head('/:namespace/:name/blobs/:digest', async (request, reply) => {
    const { digest } = request.params as { digest: string };

    const blob = await db.query.blobs.findFirst({
      where: eq(blobs.digest, digest),
    });

    if (!blob) {
      return reply.status(404).send({
        errors: [{ code: 'BLOB_UNKNOWN', message: `Blob ${digest} not found` }],
      });
    }

    reply.header('Content-Length', blob.size);
    reply.header('Docker-Content-Digest', blob.digest);
    reply.status(200).send();
  });

  // GET /v2/{namespace}/{name}/blobs/{digest}
  fastify.get('/:namespace/:name/blobs/:digest', async (request, reply) => {
    const { digest } = request.params as { digest: string };

    const blob = await db.query.blobs.findFirst({
      where: eq(blobs.digest, digest),
    });

    if (!blob) {
      return reply.status(404).send({
        errors: [{ code: 'BLOB_UNKNOWN', message: `Blob ${digest} not found` }],
      });
    }

    const data = await fastify.storage.get(blob.storageKey);

    reply.header('Content-Length', blob.size);
    reply.header('Content-Type', blob.mediaType ?? 'application/octet-stream');
    reply.header('Docker-Content-Digest', blob.digest);
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');

    return data;
  });

  // POST /v2/{namespace}/{name}/blobs/uploads/ — initiate upload
  fastify.post('/:namespace/:name/blobs/uploads/', async (request, reply) => {
    // In a full implementation, this creates an upload session.
    // For simplicity, we support monolithic upload via PUT directly.
    const uploadId = crypto.randomUUID();
    reply.header('Location', `/v2/${request.params.namespace}/${request.params.name}/blobs/uploads/${uploadId}`);
    reply.header('Range', '0-0');
    reply.status(202).send();
  });

  // PUT /v2/{namespace}/{name}/blobs/uploads/{uuid}?digest={digest}
  fastify.put('/:namespace/:name/blobs/uploads/:uuid', async (request, reply) => {
    const { namespace, name } = request.params as { namespace: string; name: string };
    const { digest } = request.query as { digest?: string };

    if (!digest) {
      return reply.status(400).send({
        errors: [{ code: 'DIGEST_INVALID', message: 'Missing digest parameter' }],
      });
    }

    // Verify SHA-256
    const body = await request.body as Buffer;
    const computed = 'sha256:' + crypto.createHash('sha256').update(body).digest('hex');

    if (computed !== digest) {
      return reply.status(400).send({
        errors: [{ code: 'DIGEST_INVALID', message: `Digest mismatch: expected ${digest}, got ${computed}` }],
      });
    }

    // Check if blob already exists (deduplication)
    const existing = await db.query.blobs.findFirst({
      where: eq(blobs.digest, digest),
    });

    if (existing) {
      reply.header('Location', `/v2/${namespace}/${name}/blobs/${digest}`);
      reply.header('Docker-Content-Digest', digest);
      reply.status(201).send();
      return;
    }

    // Store blob
    const storageKey = `blobs/${digest}`;
    await fastify.storage.put(storageKey, body);

    await db.insert(blobs).values({
      digest,
      size: body.length,
      mediaType: request.headers['content-type'] ?? 'application/octet-stream',
      storageKey,
    });

    reply.header('Location', `/v2/${namespace}/${name}/blobs/${digest}`);
    reply.header('Docker-Content-Digest', digest);
    reply.status(201).send();
  });
}
