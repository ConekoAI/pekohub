import fp from 'fastify-plugin';
import fastifyWebsocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import type { SocketStream } from '@fastify/websocket';
import { TunnelManager } from '../services/tunnel-manager.js';
import { TunnelRouter } from '../services/tunnel-router.js';

declare module 'fastify' {
  interface FastifyInstance {
    tunnelManager: TunnelManager;
    tunnelRouter: TunnelRouter;
  }
}

export default fp(async (fastify: FastifyInstance) => {
  const tunnelManager = new TunnelManager(fastify);
  const tunnelRouter = new TunnelRouter(tunnelManager);

  fastify.decorate('tunnelManager', tunnelManager);
  fastify.decorate('tunnelRouter', tunnelRouter);

  await fastify.register(fastifyWebsocket);

  fastify.get('/v1/tunnel', { websocket: true }, (connection: SocketStream) => {
    tunnelManager.handleSocket(connection.socket);
  });

  tunnelManager.startReaper();

  fastify.addHook('onClose', async () => {
    tunnelManager.stopReaper();
  });
});
