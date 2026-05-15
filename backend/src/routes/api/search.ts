import type { FastifyInstance } from 'fastify';
import { SearchQuery, SearchResponse } from '@pekohub/shared';

/**
 * Custom API: Full-text search
 * GET /api/v1/search?q=...&page=...&perPage=...&filters=...
 */
export default async function searchRoutes(fastify: FastifyInstance) {
  fastify.get('/search', async (request, reply) => {
    const parse = SearchQuery.safeParse(request.query);

    if (!parse.success) {
      return reply.status(400).send({
        error: 'Invalid query parameters',
        details: parse.error.format(),
      });
    }

    const { q, page, perPage, filters } = parse.data;

    const meiliFilters: string[] = [];
    if (filters?.bundleType) meiliFilters.push(`bundleType = ${filters.bundleType}`);
    if (filters?.extensionType) meiliFilters.push(`extensionType = ${filters.extensionType}`);
    if (filters?.modelProvider) meiliFilters.push(`modelProviders = ${filters.modelProvider}`);
    if (filters?.category) meiliFilters.push(`categories = ${filters.category}`);
    if (filters?.license) meiliFilters.push(`license = ${filters.license}`);

    const result = await fastify.search.search(q, {
      page: page - 1, // Meilisearch is 0-indexed
      hitsPerPage: perPage,
      filter: meiliFilters.length > 0 ? meiliFilters : undefined,
    });

    const response = SearchResponse.parse({
      items: result.hits,
      total: result.total,
      page: result.page,
      perPage: result.perPage,
      totalPages: Math.ceil(result.total / perPage),
    });

    return response;
  });
}
