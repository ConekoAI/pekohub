import fp from "fastify-plugin";
import { MeiliSearch, type SearchParams } from "meilisearch";
import type { FastifyInstance } from "fastify";
import type { SearchResultItem } from "@pekohub/shared";
import { db } from "../db/index.js";
import { createPostgresSearch } from "../services/pg-search.js";

const BUNDLES_INDEX = "bundles";
/** Pekos were indexed here until hub ADR-009; removed on startup. */
const RETIRED_INSTANCES_INDEX = "instances";

/**
 * Sanitize a document ID for Meilisearch.
 * Meilisearch only allows a-zA-Z0-9_- in document IDs.
 */
export function sanitizeObjectID(id: string): string {
  return id
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

export interface SearchService {
  /**
   * Index one seed version. The document is exactly
   * `SearchResultItem` — seeds carry no extension-era metadata
   * (hook points, compatibility matrix, model/MCP requirements), so
   * there is nothing to strip.
   */
  indexBundle(
    doc: SearchResultItem & {
      objectID: string;
    },
  ): Promise<void>;
  search(
    query: string,
    options?: SearchParams,
  ): Promise<{
    hits: SearchResultItem[];
    total: number;
    page: number;
    perPage: number;
  }>;
  /**
   * Remove seed documents from the index.
   *
   * One document exists per pushed version (`<namespace>-<name>-<version>`),
   * so deletion is a list, not a prefix: the previous
   * `deleteBundle("${namespace}-${name}")` never matched a real document id
   * and left deleted seeds searchable forever.
   */
  deleteBundleDocuments(objectIDs: string[]): Promise<void>;
}

/**
 * Meilisearch when `MEILISEARCH_URL` is set; otherwise search reads
 * Postgres directly, which needs no extra service (small deployments,
 * staging).
 */
async function searchPlugin(fastify: FastifyInstance) {
  const host = fastify.config.MEILISEARCH_URL;
  if (!host) {
    fastify.log.info("Search: Postgres (MEILISEARCH_URL unset)");
    fastify.decorate("search", createPostgresSearch(db));
    return;
  }
  fastify.log.info("Search: Meilisearch");
  const client = new MeiliSearch({
    host,
    apiKey: fastify.config.MEILISEARCH_API_KEY,
  });

  const bundlesIndex = client.index(BUNDLES_INDEX);

  // Ensure bundles index settings on startup
  try {
    await bundlesIndex.updateSettings({
      searchableAttributes: [
        "name",
        "namespace",
        "description",
        "tags",
        "author",
      ],
      // Seed metadata only. The extension-era facets
      // (`extensionType`, `hookPoints`, `categories`, `modelProviders`)
      // lost their producers when capabilities moved to workspace files
      // (runtime ADR-047 §5 / ADR-050).
      filterableAttributes: ["bundleType", "tags"],
      sortableAttributes: ["updatedAt", "pullCount"],
      rankingRules: [
        "words",
        "typo",
        "proximity",
        "attribute",
        "sort",
        "exactness",
      ],
    });
  } catch (err) {
    fastify.log.warn({ err }, "Failed to update Meilisearch bundle settings");
  }

  // Pekos are never searched (hub ADR-009 D2): drop what earlier
  // versions indexed of them.
  try {
    await client.deleteIndex(RETIRED_INSTANCES_INDEX);
  } catch (err) {
    fastify.log.warn({ err }, "Failed to delete the retired Meilisearch instances index");
  }

  const search: SearchService = {
    async indexBundle(doc) {
      // `objectID` must not reach the document: Meilisearch infers the
      // primary key from the attributes, and two fields ending in `id`
      // (`objectID` plus the canonical `id`) make that inference fail —
      // the task dies with "found 2 fields ending with `id`" and the
      // seed silently never becomes searchable.
      const { objectID, ...rest } = doc;
      await bundlesIndex.addDocuments([
        { ...rest, id: sanitizeObjectID(objectID) },
      ]);
    },

    async search(query, options = {}) {
      const page = options.page ?? 0;
      const perPage = options.hitsPerPage ?? 20;

      const result = await bundlesIndex.search<SearchResultItem>(query, {
        filter: options.filter,
        sort: options.sort,
        attributesToRetrieve: options.attributesToRetrieve,
        attributesToHighlight: options.attributesToHighlight,
        highlightPreTag: options.highlightPreTag,
        highlightPostTag: options.highlightPostTag,
        matchingStrategy: options.matchingStrategy,
        showMatchesPosition: options.showMatchesPosition,
        attributesToCrop: options.attributesToCrop,
        cropLength: options.cropLength,
        cropMarker: options.cropMarker,
        offset: page * perPage,
        limit: perPage,
      });

      return {
        hits: result.hits,
        total: result.estimatedTotalHits ?? 0,
        page: page + 1,
        perPage,
      };
    },

    async deleteBundleDocuments(objectIDs) {
      if (objectIDs.length === 0) return;
      await bundlesIndex.deleteDocuments(objectIDs.map(sanitizeObjectID));
    },

  };

  fastify.decorate("search", search);
}

export default fp(searchPlugin);

declare module "fastify" {
  interface FastifyInstance {
    search: SearchService;
  }
}
