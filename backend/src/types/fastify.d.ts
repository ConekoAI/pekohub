import type { Config } from "../plugins/config.js";
import type { StorageService } from "../plugins/storage.js";
import type { SearchService } from "../plugins/search.js";
import type { AuthenticatedUser } from "../plugins/auth.js";
import type { TunnelManager } from "../services/tunnel-manager.js";
import type { TunnelRouter } from "../services/tunnel-router.js";

declare module "fastify" {
  interface FastifyInstance {
    config: Config;
    storage: StorageService;
    search: SearchService;
    authenticate: (request: FastifyRequest) => Promise<AuthenticatedUser>;
    tunnelManager: TunnelManager;
    tunnelRouter: TunnelRouter;
  }

  interface FastifyRequest {
    user: AuthenticatedUser;
  }
}
