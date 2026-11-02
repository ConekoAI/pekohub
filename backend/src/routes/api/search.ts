import type { FastifyInstance } from "fastify";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import {
  formatHubRef,
  parseHubRef,
  SearchQuery,
  SearchResponse,
  type ExactHit,
  type HubRef,
} from "@pekohub/shared";
import { db } from "../../db/index.js";
import { bundles, bundleVersions, users } from "../../db/schema.js";
import { instanceService } from "../../services/instances.js";
import { pekoUrl, personUrl, seedUrl } from "../../services/origins.js";

/**
 * One search space for people, pekos and seeds (hub ADR-009).
 * GET /api/v1/search?q=...&page=...&perPage=...&filters.bundleType=principal
 *
 * The query is read as an ID first (`parseHubRef`):
 *   - `@alice` / `@alice/ada` — a person or peko, found only by its exact
 *     ID: that one, if it exists and is public, and nothing else. People
 *     and pekos are never listed or full-text searched.
 *   - `alice/ada[@1.2.0]` — a seed ID: that seed and, as an exact match,
 *     a public peko `@alice/ada`; then a text search for its words.
 *   - anything else — a full-text search over seeds.
 *
 * Exact matches come back in `exact`, on the first page only; the seed
 * search in `items`. The only seed facet is `bundleType` (one legal value,
 * `principal`).
 */
export default async function searchRoutes(fastify: FastifyInstance) {
  fastify.get("/search", async (request, reply) => {
    const parse = SearchQuery.safeParse(request.query);

    if (!parse.success) {
      return reply.status(400).send({
        error: "Invalid query parameters",
        details: parse.error.format(),
      });
    }

    const { q, page, perPage, filters } = parse.data;
    const ref = parseHubRef(q);
    const exact = page === 1 && ref ? await exactHits(fastify, ref) : [];

    // A person's or peko's ID finds that one only.
    const searchesSeeds = ref?.kind !== "person" && ref?.kind !== "peko";
    const text = ref?.kind === "seed" ? `${ref.owner} ${ref.name}` : q;

    const meiliFilters: string[] = [];
    if (filters?.bundleType)
      meiliFilters.push(`bundleType = ${filters.bundleType}`);

    const result = searchesSeeds
      ? await fastify.search.search(text, {
          page: page - 1, // Meilisearch is 0-indexed
          hitsPerPage: perPage,
          filter: meiliFilters.length > 0 ? meiliFilters : undefined,
        })
      : { hits: [], total: 0, page, perPage };

    fastify.log.debug({ result }, "Search result");

    const exactSeed = exact.find((hit) => hit.kind === "seed");
    const items = exactSeed
      ? result.hits.filter((hit) => !(hit.namespace === exactSeed.owner && hit.name === exactSeed.name))
      : result.hits;

    const total = result.total - (result.hits.length - items.length);
    const parseResponse = SearchResponse.safeParse({
      items,
      total,
      page: result.page,
      perPage: result.perPage,
      totalPages: Math.ceil(total / perPage),
      queryKind: ref?.kind ?? "text",
      exact,
    });

    if (!parseResponse.success) {
      fastify.log.error(
        { zodError: parseResponse.error.flatten() },
        "Search response failed Zod validation"
      );
      return reply.status(500).send({
        statusCode: 500,
        error: "Internal Server Error",
        message: parseResponse.error.message,
      });
    }

    return parseResponse.data;
  });

  // ── A person's page, by exact handle ────────────────────────────────────
  // Their profile; the page lists their seeds (`GET /v1/seeds?owner=`),
  // never their pekos.
  fastify.get("/people/:handle", async (request, reply) => {
    const { handle } = request.params as { handle: string };
    const ref = parseHubRef(`@${handle.replace(/^@/, "")}`);
    const user = ref?.kind === "person"
      ? await db.query.users.findFirst({ where: eq(users.namespace, ref.handle) })
      : null;
    if (!user) return reply.status(404).send({ error: "No one has that handle" });
    return {
      ...personHitOf(fastify, user),
      joinedAt: user.createdAt.toISOString(),
    };
  });
}

/** What exists for an exact ID: a person, a public peko, or a published seed. */
async function exactHits(fastify: FastifyInstance, ref: HubRef): Promise<ExactHit[]> {
  switch (ref.kind) {
    case "person": {
      const person = await personHit(fastify, ref.handle);
      return person ? [person] : [];
    }
    case "peko": {
      const peko = await pekoHit(fastify, ref.owner, ref.name);
      return peko ? [peko] : [];
    }
    case "seed": {
      // `alice/ada` is a seed's ID; a public peko `@alice/ada` is an exact
      // match too, shown as a peko.
      const [seed, peko] = await Promise.all([
        seedHit(fastify, ref.owner, ref.name, ref.version),
        ref.version ? null : pekoHit(fastify, ref.owner.toLowerCase(), ref.name),
      ]);
      return [seed, peko].filter((hit): hit is ExactHit => hit !== null);
    }
  }
}

async function personHit(fastify: FastifyInstance, handle: string): Promise<ExactHit | null> {
  const user = await db.query.users.findFirst({ where: eq(users.namespace, handle) });
  return user ? personHitOf(fastify, user) : null;
}

function personHitOf(fastify: FastifyInstance, user: typeof users.$inferSelect) {
  return {
    kind: "person" as const,
    id: formatHubRef({ kind: "person", handle: user.namespace }),
    handle: user.namespace,
    displayName: user.displayName ?? user.namespace,
    avatarUrl: user.avatarUrl ?? null,
    url: personUrl(fastify.config, user.namespace),
  };
}

async function pekoHit(fastify: FastifyInstance, owner: string, name: string): Promise<ExactHit | null> {
  const peko = await instanceService.getByHandle(owner, name);
  if (!peko || peko.exposure !== "public" || !peko.hubId) return null;
  return {
    kind: "peko",
    id: formatHubRef({ kind: "peko", owner, name: peko.name }),
    owner,
    name: peko.name,
    displayName: peko.publicName ?? peko.name,
    description: peko.description ?? null,
    avatar: peko.avatar ?? null,
    status: peko.status,
    url: pekoUrl(fastify.config, owner, peko.name),
  };
}

async function seedHit(
  fastify: FastifyInstance,
  owner: string,
  name: string,
  version: string | undefined,
): Promise<ExactHit | null> {
  const bundle = await db.query.bundles.findFirst({
    where: and(eq(bundles.namespace, owner), eq(bundles.name, name)),
  });
  if (!bundle) return null;
  // Published as text; the retired OCI rows stay hidden.
  const versions = await db
    .select({ version: bundleVersions.version, deprecated: bundleVersions.deprecated })
    .from(bundleVersions)
    .where(and(eq(bundleVersions.bundleId, bundle.id), isNotNull(bundleVersions.content)))
    .orderBy(desc(bundleVersions.createdAt), desc(bundleVersions.id));
  const shown = version
    ? versions.find((v) => v.version === version)
    : (versions.find((v) => !v.deprecated) ?? versions[0]);
  if (!shown) return null;
  return {
    kind: "seed",
    id: formatHubRef({ kind: "seed", owner: bundle.namespace, name: bundle.name, version }),
    owner: bundle.namespace,
    name: bundle.name,
    displayName: bundle.displayName ?? null,
    description: bundle.description ?? null,
    version: shown.version,
    url: seedUrl(fastify.config, bundle.namespace, bundle.name) + (version ? `@${encodeURIComponent(version)}` : ""),
  };
}
