import { describe, it, expect, afterAll, beforeAll } from "vitest";
import Fastify from "fastify";
import tunnelPlugin, { TUNNEL_MAX_MESSAGE_BYTES } from "../../src/plugins/tunnel.js";

// ─────────────────────────────────────────────────────────────────────────────
// The real tunnel endpoint refuses an oversized message instead of buffering
// it — before the handshake, where anyone can connect.
// ─────────────────────────────────────────────────────────────────────────────

describe("tunnel message size", () => {
  const app = Fastify({ logger: false });
  let url: string;

  beforeAll(async () => {
    app.decorate("config", {
      PUBLIC_ORIGIN: "http://127.0.0.1",
      JWT_SECRET: "test-secret-key-that-is-32-chars-long!!",
    } as never);
    await app.register(tunnelPlugin);
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    url = `${address.replace(/^http/, "ws")}/v1/tunnel`;
  });

  afterAll(async () => {
    await app.close();
  });

  it("closes the socket with 1009 on a message over the limit", async () => {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = reject;
    });
    const closed = new Promise<number>((resolve) => {
      socket.onclose = (event) => resolve(event.code);
    });

    socket.send(new Uint8Array(TUNNEL_MAX_MESSAGE_BYTES + 1));

    expect(await closed).toBe(1009);
  });
});
