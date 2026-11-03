import type { FastifyInstance } from "fastify";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { bundles, bundleVersions } from "../db/schema.js";

/**
 * Reading seeds as the public sees them. A seed a moderator hid, and a
 * version a moderator yanked, are not there; rows from the retired OCI
 * surface (no `content`) never were.
 */

/** The seed and its offered versions, newest first; null if it isn't shown. */
export async function findSeed(owner: string, name: string) {
  const bundle = await db.query.bundles.findFirst({
    where: and(eq(bundles.namespace, owner), eq(bundles.name, name), isNull(bundles.hiddenAt)),
  });
  if (!bundle) return null;
  const versions = await db.query.bundleVersions.findMany({
    where: and(
      eq(bundleVersions.bundleId, bundle.id),
      isNotNull(bundleVersions.content),
      isNull(bundleVersions.yankedAt),
    ),
    orderBy: (v, { desc }) => [desc(v.createdAt), desc(v.id)],
  });
  return versions.length > 0 ? { bundle, versions } : null;
}

/** The newest version that isn't deprecated, else the newest. */
export function latestOf<T extends { deprecated: boolean | null }>(versions: T[]): T {
  return versions.find((v) => !v.deprecated) ?? versions[0];
}

/** Put a seed in search at `version`; a failure leaves it published but unsearchable. */
export async function indexSeed(
  fastify: FastifyInstance,
  bundle: typeof bundles.$inferSelect,
  version: string,
) {
  try {
    await fastify.search.indexBundle({
      objectID: `${bundle.namespace}-${bundle.name}`,
      namespace: bundle.namespace,
      name: bundle.name,
      version,
      description: bundle.description ?? undefined,
      author: bundle.author ?? bundle.namespace,
      bundleType: "principal",
      tags: bundle.tags ?? [],
      pullCount: bundle.pullCount,
      updatedAt: bundle.updatedAt.toISOString(),
    });
  } catch (err) {
    fastify.log.warn({ err }, "seed indexing failed; the seed is published but not searchable yet");
  }
}

/** Take a seed out of search. */
export async function unindexSeed(fastify: FastifyInstance, owner: string, name: string) {
  try {
    await fastify.search.deleteBundleDocuments([`${owner}-${name}`]);
  } catch (err) {
    fastify.log.warn({ err }, "seed removed but its search document lingers");
  }
}

/** Re-sync search with what is shown now: the latest offered version, or nothing. */
export async function reindexSeed(fastify: FastifyInstance, owner: string, name: string) {
  const found = await findSeed(owner, name);
  if (found) await indexSeed(fastify, found.bundle, latestOf(found.versions).version);
  else await unindexSeed(fastify, owner, name);
}
