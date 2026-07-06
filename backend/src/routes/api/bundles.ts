import type { FastifyInstance } from "fastify";
import { db } from "../../db/index.js";
import { bundles, bundleVersions, pullStats, blobs } from "../../db/schema.js";
import { eq, and, sql, inArray } from "drizzle-orm";
import { BundleDetail } from "@pekohub/shared";
import { auditService } from "../../services/audit.js";

/**
 * Custom API: Bundle metadata and detail pages
 * GET /api/v1/bundles/:namespace/:name
 * GET /api/v1/bundles/:namespace/:name/versions
 * POST /api/v1/bundles/:namespace/:name/versions/:version/deprecate
 * POST /api/v1/bundles/:namespace/:name/fork
 */
export default async function bundleRoutes(fastify: FastifyInstance) {
  // GET bundle detail
  fastify.get("/bundles/:namespace/:name", async (request, reply) => {
    const { namespace, name } = request.params as {
      namespace: string;
      name: string;
    };

    const bundle = await db.query.bundles.findFirst({
      where: and(eq(bundles.namespace, namespace), eq(bundles.name, name)),
    });

    if (!bundle) {
      return reply.status(404).send({ error: "Bundle not found" });
    }

    // Fetch versions separately
    const versions = await db.query.bundleVersions.findMany({
      where: eq(bundleVersions.bundleId, bundle.id),
      orderBy: (v, { desc }) => [desc(v.createdAt)],
    });

    const latestVersion = versions[0];

    // Aggregate pull stats
    const stats = await db
      .select({
        daily: sql<number>`COALESCE(SUM(CASE WHEN ${pullStats.date} >= NOW() - INTERVAL '1 day' THEN ${pullStats.count} ELSE 0 END), 0)`,
        weekly: sql<number>`COALESCE(SUM(CASE WHEN ${pullStats.date} >= NOW() - INTERVAL '7 days' THEN ${pullStats.count} ELSE 0 END), 0)`,
        monthly: sql<number>`COALESCE(SUM(CASE WHEN ${pullStats.date} >= NOW() - INTERVAL '30 days' THEN ${pullStats.count} ELSE 0 END), 0)`,
        allTime: sql<number>`COALESCE(SUM(${pullStats.count}), 0)`,
      })
      .from(pullStats)
      .where(eq(pullStats.bundleId, bundle.id));

    const pullCounts = stats[0] ?? {
      daily: 0,
      weekly: 0,
      monthly: 0,
      allTime: bundle.pullCount,
    };

    const detail = BundleDetail.parse({
      namespace: bundle.namespace,
      name: bundle.name,
      versions: versions.map((v) => ({
        version: v.version,
        digest: v.digest,
        size: v.size,
        createdAt: v.createdAt.toISOString(),
        deprecated: v.deprecated,
        deprecatedMessage: v.deprecatedMessage,
      })),
      metadata: {
        name: bundle.name,
        description: bundle.description,
        author: bundle.author,
        license: bundle.license,
        tags: bundle.tags ?? [],
        categories: bundle.categories ?? [],
        bundleType: bundle.bundleType,
        extensionType: bundle.extensionType,
        modelProviders: bundle.modelProviders ?? [],
        requiredMcpServers: bundle.requiredMcpServers ?? [],
        homepage: bundle.homepage,
        repository: bundle.repository,
        readme: bundle.readme,
        version: latestVersion?.version ?? "0.0.0",
        deprecated: false,
        forkedFrom: bundle.forkedFrom ?? undefined,
        hooks: bundle.hooks ?? undefined,
        compatibility: bundle.compatibility ?? undefined,
      },
      readme: bundle.readme,
      pullCount: {
        daily: Number(pullCounts.daily),
        weekly: Number(pullCounts.weekly),
        monthly: Number(pullCounts.monthly),
        allTime: Number(pullCounts.allTime),
      },
      installCommand: `peko principal pull ${namespace}/${name}:${latestVersion?.version ?? "latest"}`,
    });

    return detail;
  });

  // GET version history
  fastify.get("/bundles/:namespace/:name/versions", async (request, reply) => {
    const { namespace, name } = request.params as {
      namespace: string;
      name: string;
    };

    const bundle = await db.query.bundles.findFirst({
      where: and(eq(bundles.namespace, namespace), eq(bundles.name, name)),
    });

    if (!bundle) {
      return reply.status(404).send({ error: "Bundle not found" });
    }

    const versions = await db.query.bundleVersions.findMany({
      where: eq(bundleVersions.bundleId, bundle.id),
      orderBy: (v, { desc }) => [desc(v.createdAt)],
    });

    return {
      namespace: bundle.namespace,
      name: bundle.name,
      versions: versions.map((v) => ({
        version: v.version,
        digest: v.digest,
        size: v.size,
        createdAt: v.createdAt.toISOString(),
        deprecated: v.deprecated,
        deprecatedMessage: v.deprecatedMessage,
      })),
    };
  });

  // POST deprecate / undeprecate a specific version
  fastify.post<{
    Body: { deprecated: boolean; message?: string };
  }>(
    "/bundles/:namespace/:name/versions/:version/deprecate",
    async (request, reply) => {
      const { namespace, name, version } = request.params as {
        namespace: string;
        name: string;
        version: string;
      };

      let user: { namespace: string };
      try {
        user = await fastify.authenticate(request);
      } catch {
        if (
          fastify.config.NODE_ENV === "development" &&
          fastify.config.ALLOW_DEV_AUTH_BYPASS === "true"
        ) {
          user = { namespace };
        } else {
          return reply.status(401).send({ error: "Authentication required" });
        }
      }

      if (user.namespace !== namespace) {
        return reply
          .status(403)
          .send({ error: "Namespace ownership mismatch" });
      }

      const bundle = await db.query.bundles.findFirst({
        where: and(eq(bundles.namespace, namespace), eq(bundles.name, name)),
      });

      if (!bundle) {
        return reply.status(404).send({ error: "Bundle not found" });
      }

      const { deprecated, message } = request.body;

      const [updated] = await db
        .update(bundleVersions)
        .set({
          deprecated,
          deprecatedMessage: deprecated ? (message ?? null) : null,
        })
        .where(
          and(
            eq(bundleVersions.bundleId, bundle.id),
            eq(bundleVersions.version, version),
          ),
        )
        .returning();

      if (!updated) {
        return reply.status(404).send({ error: "Version not found" });
      }

      // Fire-and-forget audit log (must not throw)
      const userId = (user as { id?: number }).id;
      await auditService.logPermissionChange(
        namespace,
        userId,
        `${namespace}/${name}:${version}`,
        {
          action: deprecated ? "deprecate" : "undeprecate",
          message: deprecated ? (message ?? null) : null,
        },
      );

      return {
        namespace,
        name,
        version: updated.version,
        deprecated: updated.deprecated,
        deprecatedMessage: updated.deprecatedMessage,
      };
    },
  );

  // DELETE a bundle and all its versions (owner only)
  fastify.delete("/bundles/:namespace/:name", async (request, reply) => {
    const { namespace, name } = request.params as {
      namespace: string;
      name: string;
    };

    let user: { namespace: string };
    try {
      user = await fastify.authenticate(request);
    } catch {
      if (
        fastify.config.NODE_ENV === "development" &&
        fastify.config.ALLOW_DEV_AUTH_BYPASS === "true"
      ) {
        user = { namespace };
      } else {
        return reply.status(401).send({ error: "Authentication required" });
      }
    }

    if (user.namespace !== namespace) {
      return reply.status(403).send({ error: "Namespace ownership mismatch" });
    }

    const bundle = await db.query.bundles.findFirst({
      where: and(eq(bundles.namespace, namespace), eq(bundles.name, name)),
    });

    if (!bundle) {
      return reply.status(404).send({ error: "Bundle not found" });
    }

    // Collect all digests referenced by this bundle's versions to check for orphaned blobs
    const versions = await db.query.bundleVersions.findMany({
      where: eq(bundleVersions.bundleId, bundle.id),
    });

    const referencedDigests = new Set<string>();
    for (const v of versions) {
      const manifest = v.manifestJson as Record<string, unknown>;
      const layers = (manifest.layers ?? []) as Array<{ digest: string }>;
      const config = manifest.config as { digest?: string } | undefined;
      if (config?.digest) referencedDigests.add(config.digest);
      for (const layer of layers) referencedDigests.add(layer.digest);
    }

    // Delete versions, pull stats, and bundle (cascades where configured)
    await db.delete(pullStats).where(eq(pullStats.bundleId, bundle.id));
    await db
      .delete(bundleVersions)
      .where(eq(bundleVersions.bundleId, bundle.id));
    await db.delete(bundles).where(eq(bundles.id, bundle.id));

    // Remove from search index
    try {
      await fastify.search.deleteBundle(`${namespace}-${name}`);
    } catch (err) {
      fastify.log.warn({ err }, "Failed to delete bundle from Meilisearch");
    }

    // Delete orphaned blobs and their S3 objects immediately
    // (instead of waiting up to 7 days for the GC window).
    //
    // NOTE: There is a narrow race window where a concurrent upload could
    // reference one of these digests after the `otherVersions` check but before
    // the DB delete. In practice uploads are much slower than this loop, and
    // the window is a few milliseconds. A full fix would require a serializable
    // transaction or advisory lock, which is left for a future hardening PR.
    if (referencedDigests.size > 0) {
      const digestsArray = Array.from(referencedDigests);
      // Find which digests are still referenced by other bundles' versions
      const otherVersions = await db.query.bundleVersions.findMany({
        where: inArray(bundleVersions.digest, digestsArray),
      });
      const stillReferenced = new Set<string>();
      for (const v of otherVersions) {
        const manifest = v.manifestJson as Record<string, unknown>;
        const layers = (manifest.layers ?? []) as Array<{ digest: string }>;
        const config = manifest.config as { digest?: string } | undefined;
        if (config?.digest) stillReferenced.add(config.digest);
        for (const layer of layers) stillReferenced.add(layer.digest);
      }

      const orphanedDigests = digestsArray.filter(
        (d) => !stillReferenced.has(d),
      );

      for (const digest of orphanedDigests) {
        try {
          const blob = await db.query.blobs.findFirst({
            where: eq(blobs.digest, digest),
          });
          if (blob) {
            // Delete DB row first so the digest cannot be referenced again
            // even if S3 deletion fails. A background sweep can clean up the
            // S3 orphan later.
            await db.delete(blobs).where(eq(blobs.digest, digest));
            await fastify.storage.delete(blob.storageKey);
          }
        } catch (err) {
          fastify.log.warn({ err, digest }, "Failed to delete orphaned blob");
        }
      }
    }

    // Fire-and-forget audit log
    const userId = (user as { id?: number }).id;
    await auditService.logDelete(namespace, userId, `${namespace}/${name}`, {
      versionsDeleted: versions.length,
      digestsReferenced: Array.from(referencedDigests),
    });

    return reply.status(204).send();
  });

  // DELETE a specific version (owner only)
  fastify.delete(
    "/bundles/:namespace/:name/versions/:version",
    async (request, reply) => {
      const { namespace, name, version } = request.params as {
        namespace: string;
        name: string;
        version: string;
      };

      let user: { namespace: string };
      try {
        user = await fastify.authenticate(request);
      } catch {
        if (
          fastify.config.NODE_ENV === "development" &&
          fastify.config.ALLOW_DEV_AUTH_BYPASS === "true"
        ) {
          user = { namespace };
        } else {
          return reply.status(401).send({ error: "Authentication required" });
        }
      }

      if (user.namespace !== namespace) {
        return reply
          .status(403)
          .send({ error: "Namespace ownership mismatch" });
      }

      const bundle = await db.query.bundles.findFirst({
        where: and(eq(bundles.namespace, namespace), eq(bundles.name, name)),
      });

      if (!bundle) {
        return reply.status(404).send({ error: "Bundle not found" });
      }

      const [deleted] = await db
        .delete(bundleVersions)
        .where(
          and(
            eq(bundleVersions.bundleId, bundle.id),
            eq(bundleVersions.version, version),
          ),
        )
        .returning();

      if (!deleted) {
        return reply.status(404).send({ error: "Version not found" });
      }

      // Fire-and-forget audit log
      const userId = (user as { id?: number }).id;
      await auditService.logDelete(
        namespace,
        userId,
        `${namespace}/${name}:${version}`,
        {
          digest: deleted.digest,
        },
      );

      return reply.status(204).send();
    },
  );

  // POST fork a bundle to the authenticated user's namespace
  fastify.post<{
    Querystring: { targetName?: string };
  }>("/bundles/:namespace/:name/fork", async (request, reply) => {
    const { namespace, name } = request.params as {
      namespace: string;
      name: string;
    };
    const { targetName } = request.query;

    let user: { id: number; namespace: string };
    try {
      user = (await fastify.authenticate(request)) as {
        id: number;
        namespace: string;
      };
    } catch {
      if (
        fastify.config.NODE_ENV === "development" &&
        fastify.config.ALLOW_DEV_AUTH_BYPASS === "true"
      ) {
        user = { id: 0, namespace: "dev-user" };
      } else {
        return reply.status(401).send({ error: "Authentication required" });
      }
    }

    const sourceBundle = await db.query.bundles.findFirst({
      where: and(eq(bundles.namespace, namespace), eq(bundles.name, name)),
    });

    if (!sourceBundle) {
      return reply.status(404).send({ error: "Bundle not found" });
    }

    const newName = targetName?.trim() || name;

    // Check for conflict in user's namespace
    const existing = await db.query.bundles.findFirst({
      where: and(
        eq(bundles.namespace, user.namespace),
        eq(bundles.name, newName),
      ),
    });

    if (existing) {
      return reply
        .status(409)
        .send({ error: `Bundle ${user.namespace}/${newName} already exists` });
    }

    // Create the forked bundle
    const [newBundle] = await db
      .insert(bundles)
      .values({
        namespace: user.namespace,
        name: newName,
        bundleType: sourceBundle.bundleType,
        extensionType: sourceBundle.extensionType,
        description: sourceBundle.description,
        author: sourceBundle.author,
        license: sourceBundle.license,
        tags: sourceBundle.tags,
        categories: sourceBundle.categories,
        modelProviders: sourceBundle.modelProviders,
        requiredMcpServers: sourceBundle.requiredMcpServers,
        homepage: sourceBundle.homepage,
        repository: sourceBundle.repository,
        readme: sourceBundle.readme,
        hooks: sourceBundle.hooks,
        compatibility: sourceBundle.compatibility,
        forkedFrom: `${namespace}/${name}`,
        starCount: 0,
        pullCount: 0,
      })
      .returning();

    // Copy all versions (blobs are content-addressable, no need to duplicate)
    const sourceVersions = await db.query.bundleVersions.findMany({
      where: eq(bundleVersions.bundleId, sourceBundle.id),
    });

    if (sourceVersions.length > 0) {
      await db.insert(bundleVersions).values(
        sourceVersions.map((v) => ({
          bundleId: newBundle.id,
          version: v.version,
          digest: v.digest,
          manifestJson: v.manifestJson,
          size: v.size,
          deprecated: v.deprecated,
          deprecatedMessage: v.deprecatedMessage,
        })),
      );
    }

    // Index into search
    try {
      const latestVersion = sourceVersions[0];
      await fastify.search.indexBundle({
        objectID: `${user.namespace}-${newName}-${latestVersion?.version ?? "latest"}`,
        namespace: user.namespace,
        name: newName,
        version: latestVersion?.version ?? "latest",
        description: newBundle.description ?? undefined,
        author: newBundle.author ?? "unknown",
        bundleType: newBundle.bundleType,
        extensionType: newBundle.extensionType ?? undefined,
        tags: newBundle.tags ?? undefined,
        pullCount: 0,
        starCount: 0,
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      fastify.log.warn({ err }, "Failed to index forked bundle in Meilisearch");
    }

    return reply.status(201).send({
      namespace: newBundle.namespace,
      name: newBundle.name,
      forkedFrom: newBundle.forkedFrom,
      versionsCopied: sourceVersions.length,
    });
  });
}
