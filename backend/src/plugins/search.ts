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
  indexBundle(
    doc: SearchResultItem & {
      objectID: string;
      compatibility?: {
        runtime?: string;
        minVersion?: string;
        maxVersion?: string;
      };
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
  deleteBundle(objectID: string): Promise<void>;
  indexInstance(doc: {
    objectID: string;
    id: string;
    name: string;
    type: string;
    bundleRef?: string;
    status: string;
    capabilities: string[];
    ownerId: number;
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
      filterableAttributes: [
        "bundleType",
        "extensionType",
        "tags",
        "categories",
        "modelProviders",
        "hookPoints",
      ],
      sortableAttributes: ["updatedAt", "pullCount", "starCount"],
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
      const { objectID, compatibility, hooks, ...rest } = doc;
      const sanitizedDoc: Record<string, unknown> = {
        ...rest,
        id: sanitizeObjectID(objectID),
        hookPoints: hooks?.map((h) => h.point) ?? [],
      };
      // Only index hooks when it is a non-null array so Meilisearch never
      // stores `null` for this field (prevents Zod response-validation 500s).
      if (hooks != null) {
        sanitizedDoc.hooks = hooks;
      }
      if (compatibility) {
        sanitizedDoc.compatibilityRuntime = compatibility.runtime;
        sanitizedDoc.compatibilityMinVersion = compatibility.minVersion;
        sanitizedDoc.compatibilityMaxVersion = compatibility.maxVersion;
      }
      await bundlesIndex.addDocuments([sanitizedDoc]);
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

    async deleteBundle(objectID) {
      await bundlesIndex.deleteDocument(sanitizeObjectID(objectID));
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
