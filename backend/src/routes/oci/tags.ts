import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { db } from "../../db/index.js";
import { bundles, bundleVersions } from "../../db/schema.js";
import { eq, and, desc } from "drizzle-orm";
import type { RepoRef } from "./repo-path.js";

/**
 * OCI Distribution Spec: Tag listing
 * GET /v2/<repo>/tags/list
 *
 * `<repo>` may be multi-segment (`peko/principals/foo`); the wildcard
 * dispatcher in `index.ts` parses it into `RepoRef` before calling
 * this handler.
 */
export async function listTags(
  _fastify: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  m: RepoRef,
) {
  const { namespace, name } = m;
  const { n = 100, last } = request.query as { n?: number; last?: string };

  const bundle = await db.query.bundles.findFirst({
    where: and(eq(bundles.namespace, namespace), eq(bundles.name, name)),
  });

  if (!bundle) {
    return reply.status(404).send({
      errors: [
        {
          code: "NAME_UNKNOWN",
          message: `Bundle ${namespace}/${name} not found`,
        },
      ],
    });
  }

  const versions = await db.query.bundleVersions.findMany({
    where: eq(bundleVersions.bundleId, bundle.id),
    orderBy: [desc(bundleVersions.createdAt)],
  });

  let tags = versions.map((v) => v.version);

  // Pagination
  if (last) {
    const idx = tags.findIndex((t) => t === last);
    tags = tags.slice(idx + 1);
  }
  tags = tags.slice(0, n);

  reply.header("Content-Type", "application/json");
  return {
    name: `${namespace}/${name}`,
    tags,
  };
}
