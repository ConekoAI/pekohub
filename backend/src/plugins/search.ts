import fp from "fastify-plugin";
import { MeiliSearch, type SearchParams } from "meilisearch";
import type { FastifyInstance } from "fastify";
import type { SearchResultItem } from "@pekohub/shared";

const BUNDLES_INDEX = "bundles";
const INSTANCES_INDEX = "instances";

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
   * Index one template version. The document is exactly
   * `SearchResultItem` — templates carry no extension-era metadata
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
   * Remove template documents from the index.
   *
   * One document exists per pushed version (`<namespace>-<name>-<version>`),
   * so deletion is a list, not a prefix: the previous
   * `deleteBundle("${namespace}-${name}")` never matched a real document id
   * and left deleted templates searchable forever.
   */
  deleteBundleDocuments(objectIDs: string[]): Promise<void>;
  indexInstance(doc: {
    objectID: string;
    id: string;
    name: string;
    type: string;
    bundleRef?: string;
    status: string;
    capabilities: string[];
    // Post-H1 the legacy `instances.owner_id` column is gone and
    // post-H3 the user-id is a UUID string. The search document
    // keeps an `ownerId` field for filterability; `null` means "no
    // known user owner" (i.e. the row is principal-owned or
    // ownerless) and the document just stores `ownerId: null`
    // rather than fabricating a 0 sentinel.
    ownerId: string | null;
    runtimeDisplayName?: string;
    createdAt: string;
    publicName?: string;
    description?: string;
    tags?: string[];
    category?: string;
    featured?: boolean;
    publishedAt?: string;
  }): Promise<void>;
  searchInstances(
    query: string,
    options?: SearchParams,
  ): Promise<{
    hits: Array<Record<string, unknown>>;
    total: number;
    page: number;
    perPage: number;
  }>;
  deleteInstance(objectID: string): Promise<void>;
}

async function searchPlugin(fastify: FastifyInstance) {
  const client = new MeiliSearch({
    host: fastify.config.MEILISEARCH_URL,
    apiKey: fastify.config.MEILISEARCH_API_KEY,
  });

  const bundlesIndex = client.index(BUNDLES_INDEX);
  const instancesIndex = client.index(INSTANCES_INDEX);

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
      // Template metadata only. The extension-era facets
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

  // Ensure instances index settings on startup
  try {
    await instancesIndex.updateSettings({
      searchableAttributes: [
        "name",
        "publicName",
        "description",
        "tags",
        "bundleRef",
        "capabilities",
        "runtimeDisplayName",
      ],
      filterableAttributes: [
        "type",
        "status",
        "capabilities",
        "category",
        "featured",
        "exposure",
      ],
      sortableAttributes: ["createdAt", "publishedAt"],
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
    fastify.log.warn({ err }, "Failed to update Meilisearch instance settings");
  }

  const search: SearchService = {
    async indexBundle(doc) {
      // `objectID` must not reach the document: Meilisearch infers the
      // primary key from the attributes, and two fields ending in `id`
      // (`objectID` plus the canonical `id`) make that inference fail —
      // the task dies with "found 2 fields ending with `id`" and the
      // template silently never becomes searchable.
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

    async indexInstance(doc) {
      await instancesIndex.addDocuments([
        {
          id: doc.objectID,
          name: doc.name,
          type: doc.type,
          bundleRef: doc.bundleRef,
          status: doc.status,
          capabilities: doc.capabilities,
          ownerId: doc.ownerId,
          runtimeDisplayName: doc.runtimeDisplayName,
          createdAt: doc.createdAt,
          publicName: doc.publicName,
          description: doc.description,
          tags: doc.tags,
          category: doc.category,
          featured: doc.featured,
          publishedAt: doc.publishedAt,
          exposure: "public",
        },
      ]);
    },

    async searchInstances(query, options = {}) {
      const page = options.page ?? 0;
      const perPage = options.hitsPerPage ?? 20;

      const result = await instancesIndex.search<Record<string, unknown>>(
        query,
        {
          filter: options.filter,
          sort: options.sort,
          offset: page * perPage,
          limit: perPage,
        },
      );

      return {
        hits: result.hits,
        total: result.estimatedTotalHits ?? 0,
        page: page + 1,
        perPage,
      };
    },

    async deleteInstance(objectID) {
      await instancesIndex.deleteDocument(objectID);
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
