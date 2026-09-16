import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import catalogRoutes from "./catalog.js";
import {
  headBlob,
  getBlob,
  initBlobUpload,
  completeBlobUpload,
} from "./blobs.js";
import { getManifest, headManifest, putManifest } from "./manifests.js";
import { listTags } from "./tags.js";
import { parseV2Wildcard } from "./repo-path.js";

/**
 * OCI Distribution Spec route aggregator.
 *
 * Multi-segment repositories (ADR-056: `peko/principals/<name>`)
 * can't be expressed with Fastify params (a param can't cross `/`
 * and wildcards must be the last token), so all repo-scoped
 * operations are dispatched through `/v2/*` wildcards and the path
 * is parsed by `parseV2Wildcard` — repo = everything before the
 * `/manifests|/blobs|/tags` suffix, name = last repo segment,
 * namespace = the rest. Legacy single-segment namespaces
 * (`alice/foo`) keep working unchanged.
 */

function notFound(reply: FastifyReply) {
  return reply.status(404).send({
    errors: [{ code: "NAME_UNKNOWN", message: "Not found" }],
  });
}

export default async function ociRoutes(fastify: FastifyInstance) {
  // Catalog is at /v2/_catalog
  await fastify.register(catalogRoutes, { prefix: "/v2" });

  const wildcard = (request: FastifyRequest) =>
    (request.params as { "*": string })["*"];

  fastify.get("/v2/*", async (request, reply) => {
    const m = parseV2Wildcard(wildcard(request));
    if (!m) return notFound(reply);
    switch (m.kind) {
      case "blob":
        return getBlob(fastify, request, reply, m);
      case "manifest":
        return getManifest(fastify, request, reply, m);
      case "tags":
        return listTags(fastify, request, reply, m);
      default:
        return notFound(reply);
    }
  });

  fastify.head("/v2/*", async (request, reply) => {
    const m = parseV2Wildcard(wildcard(request));
    if (!m) return notFound(reply);
    switch (m.kind) {
      case "blob":
        return headBlob(fastify, request, reply, m);
      case "manifest":
        return headManifest(fastify, request, reply, m);
      default:
        return notFound(reply);
    }
  });

  fastify.post("/v2/*", async (request, reply) => {
    const m = parseV2Wildcard(wildcard(request));
    if (!m) return notFound(reply);
    if (m.kind === "blobUploadInit") {
      return initBlobUpload(fastify, request, reply, m);
    }
    return notFound(reply);
  });

  fastify.put("/v2/*", async (request, reply) => {
    const m = parseV2Wildcard(wildcard(request));
    if (!m) return notFound(reply);
    switch (m.kind) {
      case "blobUploadComplete":
        return completeBlobUpload(fastify, request, reply, m);
      case "manifest":
        return putManifest(fastify, request, reply, m);
      default:
        return notFound(reply);
    }
  });
}
