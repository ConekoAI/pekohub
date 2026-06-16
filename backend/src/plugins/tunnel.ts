import fp from "fastify-plugin";
import fastifyWebsocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { SocketStream } from "@fastify/websocket";
import { TunnelManager } from "../services/tunnel-manager.js";
import { TunnelRouter } from "../services/tunnel-router.js";

declare module "fastify" {
  interface FastifyInstance {
    tunnelManager: TunnelManager;
    tunnelRouter: TunnelRouter;
  }
}

/** Per-IP cap on unauthenticated tunnel upgrades (issue #1). */
const TUNNEL_UPGRADE_RATE_MAX = 10;
const TUNNEL_UPGRADE_RATE_WINDOW = "1 minute";

export default fp(async (fastify: FastifyInstance) => {
  const tunnelManager = new TunnelManager(fastify);
  const tunnelRouter = new TunnelRouter(tunnelManager);

  fastify.decorate("tunnelManager", tunnelManager);
  fastify.decorate("tunnelRouter", tunnelRouter);

  await fastify.register(fastifyWebsocket);

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
});
