import fp from 'fastify-plugin';
import { MeiliSearch, type SearchParams } from 'meilisearch';
import type { FastifyInstance } from 'fastify';
import type { SearchResultItem } from '@pekohub/shared';

const INDEX_NAME = 'bundles';

/**
 * Sanitize a document ID for Meilisearch.
 * Meilisearch only allows a-zA-Z0-9_- in document IDs.
 */
export function sanitizeObjectID(id: string): string {
  return id
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

export interface SearchService {
  indexBundle(doc: SearchResultItem & { objectID: string; compatibility?: { runtime?: string; minVersion?: string; maxVersion?: string } }): Promise<void>;
  search(query: string, options?: SearchParams): Promise<{
    hits: SearchResultItem[];
    total: number;
    page: number;
    perPage: number;
  }>;
  deleteBundle(objectID: string): Promise<void>;
}

async function searchPlugin(fastify: FastifyInstance) {
  const client = new MeiliSearch({
    host: fastify.config.MEILISEARCH_URL,
    apiKey: fastify.config.MEILISEARCH_API_KEY,
  });

  const index = client.index(INDEX_NAME);

  // Ensure index settings on startup
  try {
    await index.updateSettings({
      searchableAttributes: [
        'name',
        'namespace',
        'description',
        'tags',
        'author',
      ],
      filterableAttributes: [
        'bundleType',
        'extensionType',
        'tags',
        'categories',
        'modelProviders',
        'hookPoints',
      ],
      sortableAttributes: ['updatedAt', 'pullCount', 'starCount'],
      rankingRules: [
        'words',
        'typo',
        'proximity',
        'attribute',
        'sort',
        'exactness',
      ],
    });
  } catch (err) {
    fastify.log.warn({ err }, 'Failed to update Meilisearch settings');
  }

  const search: SearchService = {
    async indexBundle(doc) {
      const { objectID, compatibility, ...rest } = doc;
      const sanitizedDoc: Record<string, unknown> = {
        ...rest,
        id: sanitizeObjectID(objectID),
        hookPoints: doc.hooks?.map((h) => h.point) ?? [],
      };
      if (compatibility) {
        sanitizedDoc.compatibilityRuntime = compatibility.runtime;
        sanitizedDoc.compatibilityMinVersion = compatibility.minVersion;
        sanitizedDoc.compatibilityMaxVersion = compatibility.maxVersion;
      }
      await index.addDocuments([sanitizedDoc]);
    },

    async search(query, options = {}) {
      // Use offset/limit instead of page/hitsPerPage for consistent results across Meilisearch versions
      const page = options.page ?? 0;
      const perPage = options.hitsPerPage ?? 20;

      const result = await index.search<SearchResultItem>(query, {
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
      await index.deleteDocument(sanitizeObjectID(objectID));
    },
  };

  fastify.decorate('search', search);
}

export default fp(searchPlugin);

declare module 'fastify' {
  interface FastifyInstance {
    search: SearchService;
  }
}
