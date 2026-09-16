import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { db } from "../../db/index.js";
import { blobs, bundles, pullStats } from "../../db/schema.js";
import { eq, and, sql } from "drizzle-orm";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Writable } from "node:stream";
import { shouldRecordPullStats, NAMESPACE_MAX } from "../../services/throttle.js";
import { authenticateOciWrite } from "./auth-write.js";
import type { RepoRef } from "./repo-path.js";

/**
 * OCI Distribution Spec: Blob operations
 * HEAD /v2/<repo>/blobs/<digest>
 * GET  /v2/<repo>/blobs/<digest>
 * POST /v2/<repo>/blobs/uploads/  (initiate upload)
 * PUT  /v2/<repo>/blobs/uploads/<uuid>?digest=<digest>
 *
 * `<repo>` may be multi-segment (`peko/principals/foo`); the wildcard
 * dispatcher in `index.ts` parses it into `RepoRef` before calling
 * these handlers.
 *
 * Auth (registry-hardening): uploads require a JWT or `pkr_` API key
 * (the runtime sends `Authorization: Bearer` on every push request).
 * HEAD/GET stay public so anonymous `peko pull` works.
 */

export async function headBlob(
  _fastify: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  m: { digest: string },
) {
  const blob = await db.query.blobs.findFirst({
    where: eq(blobs.digest, m.digest),
  });

  if (!blob) {
    return reply.status(404).send({
      errors: [{ code: "BLOB_UNKNOWN", message: `Blob ${m.digest} not found` }],
    });
  }

  reply.header("Content-Length", blob.size);
  reply.header("Docker-Content-Digest", blob.digest);
  reply.status(200).send();
}

export async function getBlob(
  fastify: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  m: RepoRef & { digest: string },
) {
  const blob = await db.query.blobs.findFirst({
    where: eq(blobs.digest, m.digest),
  });

  if (!blob) {
    return reply.status(404).send({
      errors: [{ code: "BLOB_UNKNOWN", message: `Blob ${m.digest} not found` }],
    });
  }

  // Increment pull stats (throttled per IP+digest and per IP+namespace)
  let throttled = false;
  try {
    const { namespace, name } = m;

    // Check throttle first to avoid the bundle DB lookup when throttled
    const shouldRecord = await shouldRecordPullStats(
      request.ip,
      m.digest,
      namespace,
    );
    if (!shouldRecord) {
      throttled = true;
    } else {
      const bundle = await db.query.bundles.findFirst({
        where: and(eq(bundles.namespace, namespace), eq(bundles.name, name)),
      });
      if (bundle) {
        await db
          .insert(pullStats)
          .values({
            bundleId: bundle.id,
            date: new Date(),
            count: 1,
          })
          .onConflictDoUpdate({
            target: [pullStats.bundleId, pullStats.date],
            set: { count: sql`${pullStats.count} + 1` },
          });
        await db
          .update(bundles)
          .set({ pullCount: sql`${bundles.pullCount} + 1` })
          .where(eq(bundles.id, bundle.id));
      }
    }
  } catch (err) {
    // Don't fail the request if stats tracking fails
    fastify.log.warn({ err }, "Failed to increment pull stats");
  }

  const data = await fastify.storage.get(blob.storageKey);

  reply.header("Content-Length", blob.size);
  reply.header("Content-Type", blob.mediaType ?? "application/octet-stream");
  reply.header("Docker-Content-Digest", blob.digest);
  reply.header("Cache-Control", "public, max-age=31536000, immutable");
  if (throttled) {
    reply.header("X-RateLimit-Limit", String(NAMESPACE_MAX));
    reply.header("X-RateLimit-Remaining", "0");
  }

  return data;
}

// POST /v2/<repo>/blobs/uploads/ — initiate upload (auth required)
export async function initBlobUpload(
  fastify: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  m: RepoRef,
) {
  const user = await authenticateOciWrite(fastify, request, m.namespace);
  if (!user) {
    return reply.status(401).send({
      errors: [{ code: "UNAUTHORIZED", message: "Authentication required" }],
    });
  }

  const uploadId = crypto.randomUUID();
  const location = `/v2/${m.namespace}/${m.name}/blobs/uploads/${uploadId}`;
  reply.header("Location", location);
  reply.header("Range", "0-0");
  reply.status(202).send();
}

// PUT /v2/<repo>/blobs/uploads/<uuid>?digest=<digest> (auth required)
// Supports both monolithic upload (body = blob bytes)
// and chunked upload completion (body empty, previously PATCHed)
export async function completeBlobUpload(
  fastify: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  m: RepoRef & { uuid: string },
) {
  const user = await authenticateOciWrite(fastify, request, m.namespace);
  if (!user) {
    return reply.status(401).send({
      errors: [{ code: "UNAUTHORIZED", message: "Authentication required" }],
    });
  }

  const { namespace, name } = m;
  const { digest } = request.query as { digest?: string };

  if (!digest) {
    return reply.status(400).send({
      errors: [
        { code: "DIGEST_INVALID", message: "Missing digest parameter" },
      ],
    });
  }

  // Collect body bytes — works for both raw Buffer and multipart file upload
  const chunks: Buffer[] = [];
  const collector = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback();
    },
  });

  // Fastify may give us a Buffer directly or a stream (multipart)
  if (Buffer.isBuffer(request.body)) {
    chunks.push(request.body);
  } else if (
    request.body &&
    typeof request.body === "object" &&
    "file" in request.body
  ) {
    // @fastify/multipart shape: { file: stream, filename, ... }
    const multipart = request.body as { file: NodeJS.ReadableStream };
    await pipeline(multipart.file, collector);
  } else if (request.raw) {
    // Raw stream fallback
    await pipeline(request.raw, collector);
  }

  const body = Buffer.concat(chunks);

  // Verify SHA-256
  const computed =
    "sha256:" + crypto.createHash("sha256").update(body).digest("hex");

  if (computed !== digest) {
    return reply.status(400).send({
      errors: [
        {
          code: "DIGEST_INVALID",
          message: `Digest mismatch: expected ${digest}, got ${computed}`,
        },
      ],
    });
  }

  // Check if blob already exists (deduplication)
  const existing = await db.query.blobs.findFirst({
    where: eq(blobs.digest, digest),
  });

  if (existing) {
    reply.header("Location", `/v2/${namespace}/${name}/blobs/${digest}`);
    reply.header("Docker-Content-Digest", digest);
    reply.status(201).send();
    return;
  }

  // Store blob
  const storageKey = `blobs/${digest}`;
  await fastify.storage.put(storageKey, body);

  await db.insert(blobs).values({
    digest,
    size: body.length,
    mediaType: request.headers["content-type"] ?? "application/octet-stream",
    storageKey,
  });

  reply.header("Location", `/v2/${namespace}/${name}/blobs/${digest}`);
  reply.header("Docker-Content-Digest", digest);
  reply.status(201).send();
}
