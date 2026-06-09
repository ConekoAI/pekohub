import type { FastifyInstance } from "fastify";
import { db } from "../../db/index.js";
import { bundles, bundleVersions } from "../../db/schema.js";
import { eq, and, desc } from "drizzle-orm";

/**
 * OCI Distribution Spec: Tag listing
 * GET /v2/{namespace}/{name}/tags/list
 *
 * Note: This route is registered with prefix /v2/:namespace/:name
 * so the handler path is just /tags/list
 */
export default async function tagRoutes(fastify: FastifyInstance) {
  fastify.get("/tags/list", async (request, reply) => {
    const { namespace, name } = request.params as {
      namespace: string;
      name: string;
    };
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
  });
}
