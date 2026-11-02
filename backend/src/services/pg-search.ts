/**
 * Search straight from Postgres, for deployments without Meilisearch.
 *
 * It reads the `bundles` table directly, so there is no
 * index to keep: the `index*` / `delete*` calls are no-ops and a change is
 * searchable the moment it is written. Matching is plain `ILIKE` — every
 * word of the query must appear in one of the searched columns — with no
 * typo tolerance or relevance ranking; results keep the caller's sort.
 *
 * Callers pass Meilisearch filter strings (`bundleType = principal`); the few
 * fields they use are mapped to columns below, and any other filter is a
 * programming error.
 */

import { and, desc, eq, or, sql, type SQL } from "drizzle-orm";
import { bundles } from "../db/schema.js";
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

function filterSql(filter: Filter, columns: Record<string, (value: string) => SQL>) {
  return parseFilters(filter).map(([field, value]) => {
    const column = columns[field];
    if (!column) throw new Error(`unsupported search filter field: ${field}`);
    return column(value);
  });
}

export function createPostgresSearch(db: DB): SearchService {
  return {
    async indexBundle() {},
    async deleteBundleDocuments() {},

    async search(query, options = {}) {
      const { index, perPage, offset } = page(options);
      // The version a seed page offers: newest non-deprecated, published as
      // text. Spelled out with an alias: in a select list Drizzle writes
      // columns unqualified, and a bare "id" here would be the version's.
      const version = sql<string>`(select "bv"."version" from "bundle_versions" "bv"
        where "bv"."bundle_id" = "bundles"."id" and "bv"."content" is not null
        order by "bv"."deprecated" asc, "bv"."created_at" desc limit 1)`;
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
  };
}
