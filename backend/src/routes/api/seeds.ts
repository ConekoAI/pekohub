import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/index.js";
import { bundles, bundleVersions, pullStats, users } from "../../db/schema.js";
import { auditService } from "../../services/audit.js";
import { shouldRecordPullStats } from "../../services/throttle.js";
import { apiOrigin, webOrigin } from "../../services/origins.js";
import {
  MAX_README_BYTES,
  isValidSeedVersion,
  seedDigest,
  validateSeed,
} from "../../services/seeds.js";

/**
 * The seed registry (runtime ADR-060; gap map S1).
 *
 * A seed is published as TOML text and named `<owner>/<name>` — the
 * publisher's handle and the seed's `name` — the same shape as a peko's
 * share path. Versions are immutable; a new version is a new upload.
 *
 *   GET    /v1/seeds                                    newest first
 *   GET    /v1/seeds/:owner/:name                       detail + latest content
 *   GET    /v1/seeds/:owner/:name/versions/:v/seed.toml download (`latest` works)
 *   POST   /v1/seeds                                    publish { seed, version, readme? }
 *   POST   /v1/seeds/:owner/:name/versions/:v/deprecate { deprecated, message? }
 *   DELETE /v1/seeds/:owner/:name[/versions/:v]
 *
 * The runtime grows one with `peko create <name> -s <file>.seed.toml`.
 */

const OWNER = "[A-Za-z0-9][A-Za-z0-9_.-]{0,127}";
const NAME = "[A-Za-z0-9][A-Za-z0-9_-]{0,63}";
const VERSION = "[0-9A-Za-z.-]{1,64}";

const PublishBody = z.object({
  seed: z.string().min(1),
  version: z.string(),
  readme: z.string().optional(),
});

type Params = { owner: string; name: string; version?: string };

/** Only seeds with content: rows from the retired OCI surface stay hidden. */
async function findSeed(owner: string, name: string) {
  const bundle = await db.query.bundles.findFirst({
    where: and(eq(bundles.namespace, owner), eq(bundles.name, name)),
  });
  if (!bundle) return null;
  const versions = await db.query.bundleVersions.findMany({
    where: and(eq(bundleVersions.bundleId, bundle.id), isNotNull(bundleVersions.content)),
    orderBy: (v, { desc }) => [desc(v.createdAt), desc(v.id)],
  });
  return versions.length > 0 ? { bundle, versions } : null;
}

/** The newest version that isn't deprecated, else the newest. */
function latestOf<T extends { deprecated: boolean | null }>(versions: T[]): T {
  return versions.find((v) => !v.deprecated) ?? versions[0];
}

async function signedIn(fastify: FastifyInstance, request: FastifyRequest) {
  try {
    return await fastify.authenticate(request);
  } catch {
    return null;
  }
}

function seedPaths(fastify: FastifyInstance, owner: string, name: string, version: string) {
  const base = `/v1/seeds/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  return {
    downloadUrl: `${apiOrigin(fastify.config)}${base}/versions/${encodeURIComponent(version)}/seed.toml`,
    webUrl: `${webOrigin(fastify.config)}/seeds/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
  };
}

async function indexSeed(
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

export default async function seedRoutes(fastify: FastifyInstance) {
  // ── List ──────────────────────────────────────────────────────────────────
  fastify.get("/seeds", async (request) => {
    const q = request.query as { page?: string; perPage?: string };
    const page = Math.max(1, Number(q.page) || 1);
    const perPage = Math.min(100, Math.max(1, Number(q.perPage) || 24));
    const published = sql`exists (select 1 from ${bundleVersions} where ${bundleVersions.bundleId} = ${bundles.id} and ${bundleVersions.content} is not null)`;
    const rows = await db
      .select()
      .from(bundles)
      .where(published)
      .orderBy(desc(bundles.updatedAt))
      .limit(perPage)
      .offset((page - 1) * perPage);
    const [{ total }] = await db
      .select({ total: sql<number>`count(*)` })
      .from(bundles)
      .where(published);
    return {
      items: rows.map((b) => ({
        owner: b.namespace,
        name: b.name,
        displayName: b.displayName,
        description: b.description,
        avatar: b.avatar,
        model: b.model,
        pullCount: b.pullCount,
        updatedAt: b.updatedAt.toISOString(),
      })),
      total: Number(total),
      page,
      perPage,
    };
  });

  // ── Detail ────────────────────────────────────────────────────────────────
  fastify.get(`/seeds/:owner(${OWNER})/:name(${NAME})`, async (request, reply) => {
    const { owner, name } = request.params as Params;
    const found = await findSeed(owner, name);
    if (!found) return reply.status(404).send({ error: "Seed not found" });
    const { bundle, versions } = found;
    const latest = latestOf(versions);
    const publisher = bundle.publisherId
      ? await db.query.users.findFirst({ where: eq(users.id, bundle.publisherId) })
      : null;
    const [weekly] = await db
      .select({
        count: sql<number>`coalesce(sum(case when ${pullStats.date} >= now() - interval '7 days' then ${pullStats.count} else 0 end), 0)`,
      })
      .from(pullStats)
      .where(eq(pullStats.bundleId, bundle.id));

    return {
      owner: {
        handle: bundle.namespace,
        displayName: publisher?.displayName ?? bundle.namespace,
        avatarUrl: publisher?.avatarUrl ?? null,
      },
      name: bundle.name,
      displayName: bundle.displayName,
      description: bundle.description,
      avatar: bundle.avatar,
      model: bundle.model,
      readme: bundle.readme,
      latestVersion: latest.version,
      content: latest.content,
      versions: versions.map((v) => ({
        version: v.version,
        digest: v.digest,
        size: v.size,
        createdAt: v.createdAt.toISOString(),
        deprecated: v.deprecated ?? false,
        deprecatedMessage: v.deprecatedMessage,
      })),
      pullCount: { allTime: bundle.pullCount, weekly: Number(weekly?.count ?? 0) },
      createdAt: bundle.createdAt.toISOString(),
      updatedAt: bundle.updatedAt.toISOString(),
      createCommand: `peko create my-${bundle.name} -s ${bundle.name}.seed.toml`,
      ...seedPaths(fastify, bundle.namespace, bundle.name, latest.version),
    };
  });

  // ── Download ──────────────────────────────────────────────────────────────
  fastify.get(
    `/seeds/:owner(${OWNER})/:name(${NAME})/versions/:version(${VERSION})/seed.toml`,
    async (request, reply) => {
      const { owner, name, version } = request.params as Params;
      const found = await findSeed(owner, name);
      if (!found) return reply.status(404).send({ error: "Seed not found" });
      const row =
        version === "latest"
          ? latestOf(found.versions)
          : found.versions.find((v) => v.version === version);
      if (!row?.content) return reply.status(404).send({ error: "Version not found" });

      try {
        if (await shouldRecordPullStats(request.ip, row.digest, owner)) {
          await db
            .insert(pullStats)
            .values({ bundleId: found.bundle.id, versionId: row.id, date: new Date(), count: 1 })
            .onConflictDoUpdate({
              target: [pullStats.bundleId, pullStats.date],
              set: { count: sql`${pullStats.count} + 1` },
            });
          await db
            .update(bundles)
            .set({ pullCount: sql`${bundles.pullCount} + 1` })
            .where(eq(bundles.id, found.bundle.id));
        }
      } catch (err) {
        fastify.log.warn({ err }, "seed pull stats not recorded");
      }

      return reply
        .header("Content-Type", "application/toml; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="${name}.seed.toml"`)
        .header("ETag", `"${row.digest}"`)
        .header("X-Seed-Version", row.version)
        .send(row.content);
    },
  );

  // ── Publish ───────────────────────────────────────────────────────────────
  fastify.post("/seeds", async (request, reply) => {
    const user = await signedIn(fastify, request);
    if (!user) return reply.status(401).send({ error: "Sign in to publish a seed" });

    const body = PublishBody.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: "Send { seed, version } with the seed's TOML text" });
    }
    const { seed, version, readme } = body.data;
    if (!isValidSeedVersion(version)) {
      return reply.status(422).send({ error: "Use a version like 1.0.0 (or 1.0.0-beta.1)" });
    }
    if (readme !== undefined && Buffer.byteLength(readme, "utf8") > MAX_README_BYTES) {
      return reply.status(422).send({ error: `A README is at most ${MAX_README_BYTES / 1024} KB` });
    }
    const checked = validateSeed(seed);
    if (!checked.ok) return reply.status(422).send({ error: checked.error });
    const { summary } = checked;
    const owner = user.namespace;

    let bundle = await db.query.bundles.findFirst({
      where: and(eq(bundles.namespace, owner), eq(bundles.name, summary.name)),
    });
    if (bundle && bundle.publisherId && bundle.publisherId !== user.id) {
      return reply.status(403).send({ error: "Only the seed's publisher can publish new versions" });
    }

    const metadata = {
      displayName: summary.displayName,
      description: summary.description,
      avatar: summary.avatar,
      model: summary.model,
      author: user.displayName ?? owner,
      ...(readme !== undefined ? { readme } : {}),
      updatedAt: new Date(),
    };
    if (!bundle) {
      [bundle] = await db
        .insert(bundles)
        .values({
          namespace: owner,
          name: summary.name,
          bundleType: "principal",
          publisherId: user.id,
          ...metadata,
        })
        .returning();
    } else {
      const existing = await db.query.bundleVersions.findFirst({
        where: and(eq(bundleVersions.bundleId, bundle.id), eq(bundleVersions.version, version)),
      });
      if (existing) {
        return reply
          .status(409)
          .send({ error: `Version ${version} is already published. Versions can't change — publish a new one.` });
      }
      [bundle] = await db
        .update(bundles)
        .set({ ...metadata, publisherId: user.id })
        .where(eq(bundles.id, bundle.id))
        .returning();
    }

    const digest = await seedDigest(seed);
    await db.insert(bundleVersions).values({
      bundleId: bundle.id,
      version,
      digest,
      content: seed,
      size: Buffer.byteLength(seed, "utf8"),
    });
    await auditService.logPush(owner, user.id, summary.name, version, digest, { via: "seeds" });
    await indexSeed(fastify, bundle, version);

    return reply.status(201).send({
      owner,
      name: summary.name,
      version,
      digest,
      ...seedPaths(fastify, owner, summary.name, version),
    });
  });

  // ── Owner actions ─────────────────────────────────────────────────────────
  async function ownSeed(request: FastifyRequest, reply: FastifyReply) {
    const user = await signedIn(fastify, request);
    if (!user) {
      reply.status(401).send({ error: "Sign in first" });
      return null;
    }
    const { owner, name } = request.params as Params;
    const found = await findSeed(owner, name);
    if (!found) {
      reply.status(404).send({ error: "Seed not found" });
      return null;
    }
    if (found.bundle.publisherId !== user.id) {
      reply.status(403).send({ error: "Only the seed's publisher can change it" });
      return null;
    }
    return { user, ...found };
  }

  fastify.post(
    `/seeds/:owner(${OWNER})/:name(${NAME})/versions/:version(${VERSION})/deprecate`,
    async (request, reply) => {
      const owned = await ownSeed(request, reply);
      if (!owned) return reply;
      const { version } = request.params as Params;
      const body = z
        .object({ deprecated: z.boolean(), message: z.string().max(500).optional() })
        .safeParse(request.body);
      if (!body.success) return reply.status(400).send({ error: "Send { deprecated, message? }" });
      const row = owned.versions.find((v) => v.version === version);
      if (!row) return reply.status(404).send({ error: "Version not found" });
      await db
        .update(bundleVersions)
        .set({
          deprecated: body.data.deprecated,
          deprecatedMessage: body.data.deprecated ? (body.data.message ?? null) : null,
        })
        .where(eq(bundleVersions.id, row.id));
      await auditService.logPermissionChange(
        owned.bundle.namespace,
        owned.user.id,
        `${owned.bundle.namespace}/${owned.bundle.name}:${version}`,
        { action: body.data.deprecated ? "deprecate" : "undeprecate" },
      );
      return { version, deprecated: body.data.deprecated };
    },
  );

  fastify.delete(
    `/seeds/:owner(${OWNER})/:name(${NAME})/versions/:version(${VERSION})`,
    async (request, reply) => {
      const owned = await ownSeed(request, reply);
      if (!owned) return reply;
      const { version } = request.params as Params;
      const row = owned.versions.find((v) => v.version === version);
      if (!row) return reply.status(404).send({ error: "Version not found" });
      if (owned.versions.length === 1) {
        return reply.status(409).send({ error: "This is the only version — delete the seed instead" });
      }
      await db.delete(bundleVersions).where(eq(bundleVersions.id, row.id));
      await auditService.logDelete(
        owned.bundle.namespace,
        owned.user.id,
        `${owned.bundle.namespace}/${owned.bundle.name}:${version}`,
      );
      return reply.status(204).send();
    },
  );

  fastify.delete(`/seeds/:owner(${OWNER})/:name(${NAME})`, async (request, reply) => {
    const owned = await ownSeed(request, reply);
    if (!owned) return reply;
    await db.delete(bundles).where(eq(bundles.id, owned.bundle.id));
    await auditService.logDelete(
      owned.bundle.namespace,
      owned.user.id,
      `${owned.bundle.namespace}/${owned.bundle.name}`,
    );
    try {
      await fastify.search.deleteBundleDocuments([`${owned.bundle.namespace}-${owned.bundle.name}`]);
    } catch (err) {
      fastify.log.warn({ err }, "seed removed but its search document lingers");
    }
    return reply.status(204).send();
  });
}
