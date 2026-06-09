import type { FastifyInstance } from "fastify";
import { db } from "../../db/index.js";
import { blobs, bundles, pullStats } from "../../db/schema.js";
import { eq, and, sql } from "drizzle-orm";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Writable } from "node:stream";
import { auditService } from "../../services/audit.js";

/**
 * OCI Distribution Spec: Blob operations
 * HEAD /v2/{namespace}/{name}/blobs/{digest}
 * GET  /v2/{namespace}/{name}/blobs/{digest}
 * POST /v2/{namespace}/{name}/blobs/uploads/  (initiate upload)
 * PATCH /v2/{namespace}/{name}/blobs/uploads/{uuid}
 * PUT  /v2/{namespace}/{name}/blobs/uploads/{uuid}?digest={digest}
 *
 * Note: This route is registered with prefix /v2/:namespace/:name
 * so handler paths are relative to that (e.g. /blobs/:digest)
 */
export default async function blobRoutes(fastify: FastifyInstance) {
  // HEAD /v2/{namespace}/{name}/blobs/{digest}
  fastify.head("/blobs/:digest", async (request, reply) => {
    const { digest } = request.params as { digest: string };

    const blob = await db.query.blobs.findFirst({
      where: eq(blobs.digest, digest),
    });

    if (!blob) {
      return reply.status(404).send({
        errors: [{ code: "BLOB_UNKNOWN", message: `Blob ${digest} not found` }],
      });
    }

    reply.header("Content-Length", blob.size);
    reply.header("Docker-Content-Digest", blob.digest);
    reply.status(200).send();
  });

  // GET /v2/{namespace}/{name}/blobs/{digest}
  fastify.get("/blobs/:digest", async (request, reply) => {
    const { digest } = request.params as { digest: string };

    const blob = await db.query.blobs.findFirst({
      where: eq(blobs.digest, digest),
    });

    if (!blob) {
      return reply.status(404).send({
        errors: [{ code: "BLOB_UNKNOWN", message: `Blob ${digest} not found` }],
      });
    }

    // Increment pull stats
    let bundleForAudit:
      | { id: number; name: string; namespace: string }
      | undefined;
    try {
      const { namespace, name } = request.params as {
        namespace: string;
        name: string;
      };
      const bundle = await db.query.bundles.findFirst({
        where: and(eq(bundles.namespace, namespace), eq(bundles.name, name)),
      });
      if (bundle) {
        bundleForAudit = bundle;
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
    } catch (err) {
      // Don't fail the request if stats tracking fails
      fastify.log.warn({ err }, "Failed to increment pull stats");
    }

    const data = await fastify.storage.get(blob.storageKey);

    reply.header("Content-Length", blob.size);
    reply.header("Content-Type", blob.mediaType ?? "application/octet-stream");
    reply.header("Docker-Content-Digest", blob.digest);
    reply.header("Cache-Control", "public, max-age=31536000, immutable");

    return data;
  });

  // POST /v2/{namespace}/{name}/blobs/uploads/ — initiate upload
  fastify.post("/blobs/uploads/", async (request, reply) => {
    const uploadId = crypto.randomUUID();
    const location = `/v2/${(request.params as { namespace: string; name: string }).namespace}/${(request.params as { namespace: string; name: string }).name}/blobs/uploads/${uploadId}`;
    reply.header("Location", location);
    reply.header("Range", "0-0");
    reply.status(202).send();
  });

  // PUT /v2/{namespace}/{name}/blobs/uploads/{uuid}?digest={digest}
  // Supports both monolithic upload (body = blob bytes)
  // and chunked upload completion (body empty, previously PATCHed)
  fastify.put("/blobs/uploads/:uuid", async (request, reply) => {
    const { namespace, name } = request.params as {
      namespace: string;
      name: string;
    };
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
  });
}
