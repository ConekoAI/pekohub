import fp from "fastify-plugin";
import fastifyWebsocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { SocketStream } from "@fastify/websocket";
import { TunnelManager } from "../services/tunnel-manager.js";
import { TunnelRouter } from "../services/tunnel-router.js";
import { InMemoryQuotaStore } from "../services/quotas.js";

declare module "fastify" {
  interface FastifyInstance {
    tunnelManager: TunnelManager;
    tunnelRouter: TunnelRouter;
  }
}

/**
 * Largest tunnel message accepted, in bytes. The biggest a runtime sends is
 * a history page (at most 100 events) or a proxied reply; `ws` would
 * otherwise buffer up to 100 MiB per message, before the handshake too.
 * A bigger message closes the socket with 1009.
 */
export const TUNNEL_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

/** Per-IP cap on unauthenticated tunnel upgrades (issue #1). */
const TUNNEL_UPGRADE_RATE_MAX = 10;
const TUNNEL_UPGRADE_RATE_WINDOW = "1 minute";

/**
 * Registered under an explicit `name` because `src/plugins/quotas.ts`
 * declares `dependencies: ["tunnel"]` — fastify resolves that string
 * against the plugin name, so an anonymous wrapper makes the dependency
 * unresolvable and the whole server fails to boot.
 */
export default fp(
  async (fastify: FastifyInstance) => {
    const tunnelManager = new TunnelManager(fastify);
    // Default to in-memory; the `quotas` plugin overwrites this
    // reference with Redis or stays in-memory depending on REDIS_URL.
    const tunnelRouter = new TunnelRouter(
      tunnelManager,
      new InMemoryQuotaStore(),
      {
        issuer: fastify.config.PUBLIC_ORIGIN,
        jwtSecret: fastify.config.JWT_SECRET,
      },
    );

    fastify.decorate("tunnelManager", tunnelManager);
    fastify.decorate("tunnelRouter", tunnelRouter);

    await fastify.register(fastifyWebsocket, {
      options: { maxPayload: TUNNEL_MAX_MESSAGE_BYTES },
    });

    fastify.get(
      "/v1/tunnel",
      {
        websocket: true,
        config: {
          // Tighter than the global API cap: a runtime that flaps
          // re-handshakes, but it should never exceed this. Counts
          // only the unauthenticated upgrade, not post-handshake
          // message traffic.
          rateLimit: {
            max: TUNNEL_UPGRADE_RATE_MAX,
            timeWindow: TUNNEL_UPGRADE_RATE_WINDOW,
          },
        },
      },
      (connection: SocketStream) => {
        tunnelManager.handleSocket(connection.socket);
      },
    );

    tunnelManager.startReaper();

    fastify.addHook("onClose", async () => {
      tunnelManager.stopReaper();
    });
  },
  { name: "tunnel" },
);
