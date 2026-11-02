/**
 * Search straight from Postgres, for deployments without Meilisearch.
 *
 * It reads the `bundles` and `instances` tables directly, so there is no
 * index to keep: the `index*` / `delete*` calls are no-ops and a change is
 * searchable the moment it is written. Matching is plain `ILIKE` — every
 * word of the query must appear in one of the searched columns — with no
 * typo tolerance or relevance ranking; results keep the caller's sort.
 *
 * Callers pass Meilisearch filter strings (`exposure = public`); the few
 * fields they use are mapped to columns below, and any other filter is a
 * programming error.
 */

import { and, desc, eq, or, sql, type SQL } from "drizzle-orm";
import type { Subject } from "@pekohub/shared";
import { bundles, bundleVersions, instances } from "../db/schema.js";
import type { DB } from "../db/index.js";
import type { SearchService } from "../plugins/search.js";

type Filter = string | string[] | (string | string[])[] | undefined;

/** `["a = b", ["c = d"]]` → `[["a", "b"], ["c", "d"]]`. */
export function parseFilters(filter: Filter): Array<[string, string]> {
  if (!filter) return [];
  const flat = (Array.isArray(filter) ? filter : [filter]).flat();
  return flat.map((clause) => {
    const match = /^\s*(\w+)\s*=\s*(.+?)\s*$/.exec(clause);
    if (!match) throw new Error(`unsupported search filter: ${clause}`);
    return [match[1], match[2].replace(/^["']|["']$/g, "")];
  });
}

/** Escape `ILIKE` wildcards so a query is matched literally. */
function likePattern(word: string) {
  return `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Every word of `query` appears in at least one of `columns`. */
function matchesWords(query: string, columns: SQL[]): SQL | undefined {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return undefined;
  return and(
    ...words.map((word) => or(...columns.map((column) => sql`${column} ilike ${likePattern(word)}`))!),
  );
}

function page(options: { page?: number; hitsPerPage?: number }) {
  const index = options.page ?? 0;
  const perPage = options.hitsPerPage ?? 20;
  return { index, perPage, offset: index * perPage };
}

const SEED_FILTERS: Record<string, (value: string) => SQL> = {
  bundleType: (value) => eq(bundles.bundleType, value as "principal"),
};

const INSTANCE_FILTERS: Record<string, (value: string) => SQL> = {
  exposure: (value) => eq(instances.exposure, value),
  category: (value) => eq(instances.category, value),
  featured: (value) => eq(instances.featured, value === "true"),
  type: (value) => eq(instances.type, value),
  status: (value) => eq(instances.status, value),
};

const INSTANCE_SORTS: Record<string, SQL> = {
  createdAt: sql`${instances.createdAt}`,
  publishedAt: sql`${instances.publishedAt}`,
};

function filterSql(filter: Filter, columns: Record<string, (value: string) => SQL>) {
  return parseFilters(filter).map(([field, value]) => {
    const column = columns[field];
    if (!column) throw new Error(`unsupported search filter field: ${field}`);
    return column(value);
  });
}

function sortSql(sort: string[] | undefined) {
  return (sort ?? []).map((clause) => {
    const [field, direction] = clause.split(":");
    const column = INSTANCE_SORTS[field];
    if (!column) throw new Error(`unsupported search sort field: ${field}`);
    return direction === "asc" ? sql`${column} asc nulls last` : sql`${column} desc nulls last`;
  });
}

function ownerId(subject: Subject | null) {
  return subject?.kind === "user" && subject.id ? subject.id : null;
}

export function createPostgresSearch(db: DB): SearchService {
  return {
    async indexBundle() {},
    async deleteBundleDocuments() {},
    async indexInstance() {},
    async deleteInstance() {},

    async search(query, options = {}) {
      const { index, perPage, offset } = page(options);
      // The version a seed page offers: newest non-deprecated, published as text.
      const version = sql<string>`(select ${bundleVersions.version} from ${bundleVersions}
        where ${bundleVersions.bundleId} = ${bundles.id} and ${bundleVersions.content} is not null
        order by ${bundleVersions.deprecated} asc, ${bundleVersions.createdAt} desc limit 1)`;
      const where = and(
        sql`${version} is not null`,
        ...filterSql(options.filter, SEED_FILTERS),
        matchesWords(query, [
          sql`${bundles.name}`,
          sql`${bundles.namespace}`,
          sql`coalesce(${bundles.description}, '')`,
          sql`coalesce(${bundles.author}, '')`,
          sql`coalesce(${bundles.tags}::text, '')`,
        ]),
      );

      const [rows, [{ count }]] = await Promise.all([
        db
          .select({
            namespace: bundles.namespace,
            name: bundles.name,
            version,
            description: bundles.description,
            author: bundles.author,
            tags: bundles.tags,
            pullCount: bundles.pullCount,
            updatedAt: bundles.updatedAt,
          })
          .from(bundles)
          .where(where)
          .orderBy(desc(bundles.updatedAt))
          .limit(perPage)
          .offset(offset),
        db.select({ count: sql<number>`count(*)::int` }).from(bundles).where(where),
      ]);

      return {
        hits: rows.map((row) => ({
          namespace: row.namespace,
          name: row.name,
          version: row.version,
          description: row.description ?? undefined,
          author: row.author ?? row.namespace,
          bundleType: "principal" as const,
          tags: row.tags ?? [],
          pullCount: row.pullCount,
          updatedAt: new Date(row.updatedAt).toISOString(),
        })),
        total: Number(count),
        page: index + 1,
        perPage,
      };
    },

    async searchInstances(query, options = {}) {
      const { index, perPage, offset } = page(options);
      const where = and(
        ...filterSql(options.filter, INSTANCE_FILTERS),
        matchesWords(query, [
          sql`${instances.name}`,
          sql`coalesce(${instances.publicName}, '')`,
          sql`coalesce(${instances.description}, '')`,
          sql`coalesce(${instances.tags}::text, '')`,
          sql`coalesce(${instances.bundleRef}, '')`,
          sql`coalesce(${instances.runtimeDisplayName}, '')`,
        ]),
      );
      const order = sortSql(options.sort as string[] | undefined);

      const [rows, [{ count }]] = await Promise.all([
        db
          .select()
          .from(instances)
          .where(where)
          .orderBy(...(order.length > 0 ? order : [desc(instances.createdAt)]))
          .limit(perPage)
          .offset(offset),
        db.select({ count: sql<number>`count(*)::int` }).from(instances).where(where),
      ]);

      return {
        // The same fields the Meilisearch documents carry.
        hits: rows.map((row) => ({
          id: row.id,
          name: row.name,
          type: row.type,
          bundleRef: row.bundleRef ?? undefined,
          status: row.status,
          capabilities: row.capabilities,
          ownerId: ownerId(row.ownerSubject),
          runtimeDisplayName: row.runtimeDisplayName ?? undefined,
          createdAt: new Date(row.createdAt).toISOString(),
          publicName: row.publicName ?? undefined,
          description: row.description ?? undefined,
          tags: row.tags ?? [],
          category: row.category ?? undefined,
          featured: row.featured ?? false,
          publishedAt: row.publishedAt ? new Date(row.publishedAt).toISOString() : undefined,
          exposure: row.exposure,
        })),
        total: Number(count),
        page: index + 1,
        perPage,
      };
    },
  };
}
