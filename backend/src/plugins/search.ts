import fp from 'fastify-plugin';
import { MeiliSearch, type SearchParams } from 'meilisearch';
import type { FastifyInstance } from 'fastify';
import type { SearchResultItem } from '@pekohub/shared';

const INDEX_NAME = 'bundles';

export interface SearchService {
  indexBundle(doc: SearchResultItem & { objectID: string }): Promise<void>;
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
      await index.addDocuments([doc]);
    },

    async search(query, options = {}) {
      const result = await index.search<SearchResultItem>(query, {
        ...options,
        hitsPerPage: options.hitsPerPage ?? 20,
        page: options.page ?? 0,
      });

      return {
        hits: result.hits,
        total: result.estimatedTotalHits ?? result.totalHits ?? 0,
        page: (result.page ?? 0) + 1,
        perPage: result.hitsPerPage ?? 20,
      };
    },

    async deleteBundle(objectID) {
      await index.deleteDocument(objectID);
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
