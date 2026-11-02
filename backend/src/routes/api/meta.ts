import type { FastifyInstance } from "fastify";
import { apiOrigin, tunnelUrl, webOrigin } from "../../services/origins.js";

/**
 * `GET /v1/meta` — where things live. Clients build API calls from
 * `apiOrigin`, connect the runtime tunnel to `tunnelUrl`, and build links
 * people open (share links, seed pages) from `pages`.
 */
export default async function metaRoutes(fastify: FastifyInstance) {
  fastify.get("/meta", async (_request, reply) => {
    reply.header("Cache-Control", "public, max-age=300");
    return {
      apiOrigin: apiOrigin(fastify.config),
      webOrigin: webOrigin(fastify.config),
      tunnelUrl: tunnelUrl(fastify.config),
      // Page links on the website, by ID (hub ADR-009 D1). Fill in
      // `{owner}` / `{name}`; the old `/peko/…` and `/seeds/…` pages
      // redirect to these.
      pages: {
        person: `${webOrigin(fastify.config)}/@{owner}`,
        peko: `${webOrigin(fastify.config)}/@{owner}/{name}`,
        seed: `${webOrigin(fastify.config)}/{owner}/{name}`,
      },
    };
  });
}
