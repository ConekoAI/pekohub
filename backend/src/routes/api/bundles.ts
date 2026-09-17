import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { db } from "../../db/index.js";
import { bundles, bundleVersions, pullStats, blobs } from "../../db/schema.js";
import { eq, and, sql, inArray } from "drizzle-orm";
import { BundleDetail } from "@pekohub/shared";
import { auditService } from "../../services/audit.js";

/**
 * Custom API: Seed metadata and detail pages.
 *
 * Namespaces may be multi-segment (`peko/principals`), which Fastify
 * params cannot express, so every route here is a `/bundles/*`
 * wildcard and the path is parsed by the helpers below: name = last
 * repo segment, namespace = the middle, with the operation suffix
 * (`/versions`, `/versions/:v/deprecate`) stripped first.
 * Legacy `GET /v1/bundles/alice/foo` keeps working unchanged.
 *
 * Mounted under both `/v1` and `/api/v1` (the runtime CLI calls the
 * `/api/v1` surface — see peko-rs/cli/src/commands/search.rs), so the
 * `bundles` path is a wire-compatibility name: the artifact it serves
 * is a *seed*. `fork` was the other half of the package catalog and
 * is gone — a seed is DNA, re-pushed from a workspace with
 * `peko push`, never copied out of the registry.
 */

interface RepoPath {
  namespace: string;
  name: string;
}

/** Split `ns[/ns...]/name` into namespace + name (last segment). */
function splitRepoPath(repo: string): RepoPath | null {
  const idx = repo.lastIndexOf("/");
  if (idx <= 0 || idx === repo.length - 1) return null;
  return { namespace: repo.slice(0, idx), name: repo.slice(idx + 1) };
}

/** Parse `<repo>/versions` → repo, or null. */
function stripSuffix(wildcard: string, suffix: string): string | null {
  return wildcard.endsWith(suffix)
    ? wildcard.slice(0, -suffix.length) || null
    : null;
}

const DEPRECATE_RE = /^(.*)\/versions\/([^/]+)\/deprecate$/;
const VERSION_DELETE_RE = /^(.*)\/versions\/([^/]+)$/;

type Caller = { id?: string; namespace: string };

/**
 * Publisher ownership check (ADR-056). The bundle's `publisher_id`
 * is authoritative; legacy rows with NULL publisher_id fall back to
 * the pre-publisher rule (caller's namespace == bundle namespace).
 * Dev-bypass callers (no id) pass on the namespace fallback only.
 */
function callerOwnsBundle(
  bundle: { publisherId: string | null; namespace: string },
  user: Caller,
): boolean {
  if (bundle.publisherId) return user.id === bundle.publisherId;
  return user.namespace === bundle.namespace;
}

/** Authenticate with the same dev-bypass fallback as the OCI routes. */
async function authenticateBundleWrite(
  fastify: FastifyInstance,
  request: FastifyRequest,
  bypassNamespace: string,
): Promise<Caller | null> {
  try {
    return await fastify.authenticate(request);
  } catch {
    if (
      fastify.config.NODE_ENV === "development" &&
      fastify.config.ALLOW_DEV_AUTH_BYPASS === "true"
    ) {
      return { namespace: bypassNamespace };
    }
    return null;
  }
}

/** Registry host for the install command (scheme stripped). */
function registryHost(fastify: FastifyInstance): string {
  return fastify.config.REGISTRY_BASE_URL.replace(/^https?:\/\//, "").replace(
    /\/$/,
    "",
  );
}

export default async function bundleRoutes(fastify: FastifyInstance) {
  // ── GET /bundles/* — bundle detail, or <repo>/versions ────────────────────
  fastify.get("/bundles/*", async (request, reply) => {
    const wildcard = (request.params as { "*": string })["*"];

    const versionsRepo = stripSuffix(wildcard, "/versions");
    if (versionsRepo !== null) {
      const repo = splitRepoPath(versionsRepo);
      if (!repo) return reply.status(404).send({ error: "Bundle not found" });
      return versionHistory(reply, repo);
    }

    const repo = splitRepoPath(wildcard);
    if (!repo) return reply.status(404).send({ error: "Bundle not found" });
    return bundleDetail(fastify, reply, repo);
  });

  // ── POST /bundles/* — <repo>/versions/:v/deprecate ────────────────────────
  fastify.post("/bundles/*", async (request, reply) => {
    const wildcard = (request.params as { "*": string })["*"];

    const deprecateMatch = DEPRECATE_RE.exec(wildcard);
    if (deprecateMatch) {
      const repo = splitRepoPath(deprecateMatch[1]);
      if (!repo) return reply.status(404).send({ error: "Seed not found" });
      return deprecateVersion(fastify, request, reply, repo, deprecateMatch[2]);
    }

    return reply.status(404).send({ error: "Not found" });
  });

  // ── DELETE /bundles/* — whole bundle, or <repo>/versions/:v ───────────────
  fastify.delete("/bundles/*", async (request, reply) => {
    const wildcard = (request.params as { "*": string })["*"];

    const versionMatch = VERSION_DELETE_RE.exec(wildcard);
    if (versionMatch) {
      const repo = splitRepoPath(versionMatch[1]);
      if (!repo) return reply.status(404).send({ error: "Bundle not found" });
      return deleteVersion(fastify, request, reply, repo, versionMatch[2]);
    }

    const repo = splitRepoPath(wildcard);
    if (!repo) return reply.status(404).send({ error: "Bundle not found" });
    return deleteBundle(fastify, request, reply, repo);
  });

  // ── Handlers ───────────────────────────────────────────────────────────────

  async function bundleDetail(
    fastify: FastifyInstance,
    reply: FastifyReply,
    repo: RepoPath,
  ) {
    const { namespace, name } = repo;

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
        // Seed pushes (ADR-056) carry no author/description
        // annotations — coalesce so the detail payload stays valid
        // for the CLI (`peko search` bundle detail flow).
        description: bundle.description ?? undefined,
        author: bundle.author ?? "unknown",
        license: bundle.license,
        tags: bundle.tags ?? [],
        bundleType: bundle.bundleType,
        homepage: bundle.homepage,
        repository: bundle.repository,
        readme: bundle.readme,
        version: latestVersion?.version ?? "0.0.0",
        deprecated: false,
      },
      readme: bundle.readme,
      pullCount: {
        daily: Number(pullCounts.daily),
        weekly: Number(pullCounts.weekly),
        monthly: Number(pullCounts.monthly),
        allTime: Number(pullCounts.allTime),
      },
      // `peko pull` resolves `<host>/<repo>:<tag>` against the OCI
      // endpoints above; bare `name:tag` only works against a
      // configured default registry (peko-rs registry client).
      installCommand: `peko pull ${registryHost(fastify)}/${namespace}/${name}:${latestVersion?.version ?? "latest"}`,
    });

    return detail;
  }

  async function versionHistory(reply: FastifyReply, repo: RepoPath) {
    const { namespace, name } = repo;

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
  }

  async function deprecateVersion(
    fastify: FastifyInstance,
    request: FastifyRequest,
    reply: FastifyReply,
    repo: RepoPath,
    version: string,
  ) {
    const { namespace, name } = repo;

    const user = await authenticateBundleWrite(fastify, request, namespace);
    if (!user) {
      return reply.status(401).send({ error: "Authentication required" });
    }

    const bundle = await db.query.bundles.findFirst({
      where: and(eq(bundles.namespace, namespace), eq(bundles.name, name)),
    });

    if (!bundle) {
      return reply.status(404).send({ error: "Bundle not found" });
    }

    if (!callerOwnsBundle(bundle, user)) {
      return reply.status(403).send({ error: "Not the bundle publisher" });
    }

    const { deprecated, message } = request.body as {
      deprecated: boolean;
      message?: string;
    };

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
    await auditService.logPermissionChange(
      namespace,
      user.id,
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
  }

  async function deleteBundle(
    fastify: FastifyInstance,
    request: FastifyRequest,
    reply: FastifyReply,
    repo: RepoPath,
  ) {
    const { namespace, name } = repo;

    const user = await authenticateBundleWrite(fastify, request, namespace);
    if (!user) {
      return reply.status(401).send({ error: "Authentication required" });
    }

    const bundle = await db.query.bundles.findFirst({
      where: and(eq(bundles.namespace, namespace), eq(bundles.name, name)),
    });

    if (!bundle) {
      return reply.status(404).send({ error: "Bundle not found" });
    }

    if (!callerOwnsBundle(bundle, user)) {
      return reply.status(403).send({ error: "Not the bundle publisher" });
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

    // Remove every version's document from the search index. The ids are
    // `<namespace>-<name>-<version>`, so this must enumerate the versions —
    // a bundle-level prefix does not match any document.
    try {
      await fastify.search.deleteBundleDocuments(
        versions.map((v) => `${namespace}-${name}-${v.version}`),
      );
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
    await auditService.logDelete(namespace, user.id, `${namespace}/${name}`, {
      versionsDeleted: versions.length,
      digestsReferenced: Array.from(referencedDigests),
    });

    return reply.status(204).send();
  }

  async function deleteVersion(
    fastify: FastifyInstance,
    request: FastifyRequest,
    reply: FastifyReply,
    repo: RepoPath,
    version: string,
  ) {
    const { namespace, name } = repo;

    const user = await authenticateBundleWrite(fastify, request, namespace);
    if (!user) {
      return reply.status(401).send({ error: "Authentication required" });
    }

    const bundle = await db.query.bundles.findFirst({
      where: and(eq(bundles.namespace, namespace), eq(bundles.name, name)),
    });

    if (!bundle) {
      return reply.status(404).send({ error: "Bundle not found" });
    }

    if (!callerOwnsBundle(bundle, user)) {
      return reply.status(403).send({ error: "Not the bundle publisher" });
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

    // Drop this version's search document. Without this the deleted
    // version stayed searchable and kept linking to a 404.
    try {
      await fastify.search.deleteBundleDocuments([
        `${namespace}-${name}-${version}`,
      ]);
    } catch (err) {
      fastify.log.warn({ err }, "Failed to delete version from Meilisearch");
    }

    // Fire-and-forget audit log
    await auditService.logDelete(
      namespace,
      user.id,
      `${namespace}/${name}:${version}`,
      {
        digest: deleted.digest,
      },
    );

    return reply.status(204).send();
  }
}
