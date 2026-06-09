import { describe, it, expect, beforeEach } from "vitest";
import Fastify from "fastify";
import { TunnelRouter } from "../../src/services/tunnel-router.js";
import { TunnelManager } from "../../src/services/tunnel-manager.js";

describe("TunnelRouter", () => {
  let app: Fastify.FastifyInstance;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    app.decorate("config", { NODE_ENV: "test" });
  });

  it("sendControl does not throw even when broadcastControl fails", () => {
    const manager = new TunnelManager(app);
    const router = new TunnelRouter(manager);

    // Force broadcastControl to throw by mocking it
    manager.broadcastControl = async () => {
      throw new Error("websocket send failed");
    };

    expect(() => {
      router.sendControl("did:key:zMissing", {
        type: "exposure_update",
        payload: {
          instanceId: "inst-1",
          exposure: "public",
        },
      });
    }).not.toThrow();
  });
});
