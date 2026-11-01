import type { FastifyInstance } from "fastify";
import { apiOrigin, tunnelUrl, webOrigin } from "../../services/origins.js";

/**
 * `GET /v1/meta` — where things live. Clients build API calls from
 * `apiOrigin`, connect the runtime tunnel to `tunnelUrl`, and build links
 * people open (share links, seed pages) from `webOrigin`.
 */
export default async function metaRoutes(fastify: FastifyInstance) {
  fastify.get("/meta", async (_request, reply) => {
    reply.header("Cache-Control", "public, max-age=300");
    return {
      apiOrigin: apiOrigin(fastify.config),
      webOrigin: webOrigin(fastify.config),
      tunnelUrl: tunnelUrl(fastify.config),
    };
  });
}
