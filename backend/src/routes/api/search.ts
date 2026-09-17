import type { FastifyInstance } from "fastify";
import { SearchQuery, SearchResponse } from "@pekohub/shared";

/**
 * Custom API: Full-text search over seeds.
 * GET /api/v1/search?q=...&page=...&perPage=...&filters.bundleType=principal
 *
 * The only facet left is `bundleType`, which has exactly one legal value
 * (`principal`). The extension-era facets — `extensionType`,
 * `modelProvider`, `category`, `license` — are gone: their producers
 * (the `.ext` / `.agent` package manifests) were retired by runtime
 * ADR-037 / ADR-047 §5 / ADR-050, and `license` was never in the index
 * to begin with (a filter on it would have 400'd Meilisearch).
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

    const meiliFilters: string[] = [];
    if (filters?.bundleType)
      meiliFilters.push(`bundleType = ${filters.bundleType}`);

    const result = await fastify.search.search(q, {
      page: page - 1, // Meilisearch is 0-indexed
      hitsPerPage: perPage,
      filter: meiliFilters.length > 0 ? meiliFilters : undefined,
    });

    fastify.log.debug({ result }, "Search result from Meilisearch");

    const parseResponse = SearchResponse.safeParse({
      items: result.hits,
      total: result.total,
      page: result.page,
      perPage: result.perPage,
      totalPages: Math.ceil(result.total / perPage),
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

    fastify.log.debug({ response: parseResponse.data }, "Parsed search response");

    return parseResponse.data;
  });
}
