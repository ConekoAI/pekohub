import { describe, it, expect, beforeEach } from "vitest";
import { EventEmitter } from "events";
import Fastify from "fastify";
import { TunnelManager } from "../../src/services/tunnel-manager.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import type { TunnelMessage } from "../../src/services/tunnel-protocol.js";

const ED25519_PUB_MULTICODEC = new Uint8Array([0xed, 0x01]);

class MockWebSocket extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  sent: TunnelMessage[] = [];
  closed = false;
  closeCode?: number;
  closeReason?: string;

  send(data: Buffer) {
    this.sent.push(JSON.parse(data.toString("utf8")) as TunnelMessage);
  }

  close(code?: number, reason?: string) {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = 3; // CLOSED
    this.emit("close");
  }

  triggerMessage(msg: TunnelMessage) {
    this.emit("message", Buffer.from(JSON.stringify(msg), "utf8"));
  }
}

function makeRuntimeIdentity(): { did: string; privateKey: Uint8Array } {
  const { secretKey } = ed25519.keygen();
  const publicKey = ed25519.getPublicKey(secretKey);
  const encoded = base58.encode(
    new Uint8Array([...ED25519_PUB_MULTICODEC, ...publicKey]),
  );
  return { did: `did:key:z${encoded}`, privateKey: secretKey };
}

function signHello(privateKey: Uint8Array, nonce: string): string {
  const signature = ed25519.sign(new TextEncoder().encode(nonce), privateKey);
  return Buffer.from(signature).toString("base64");
}

async function buildFastify() {
  const app = Fastify({ logger: false });
  app.decorate("config", { NODE_ENV: "test" });
  return app;
}

describe("TunnelManager", () => {
  let app: Awaited<ReturnType<typeof buildFastify>>;

  beforeEach(async () => {
    app = await buildFastify();
  });

  it("authenticates a valid RuntimeHello and sends TunnelReady", async () => {
    const manager = new TunnelManager(app);
    const socket = new MockWebSocket();
    const { did, privateKey } = makeRuntimeIdentity();
    const nonce = "nonce-1";

    manager.handleSocket(socket as any);
    socket.triggerMessage({
      type: "runtime_hello",
      runtimeId: did,
      nonce,
      signature: signHello(privateKey, nonce),
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(socket.sent.length).toBeGreaterThanOrEqual(1);
    expect(socket.sent[0].type).toBe("tunnel_ready");
  });

  it("rejects an invalid RuntimeHello signature and closes socket", async () => {
    const manager = new TunnelManager(app);
    const socket = new MockWebSocket();
    const { did } = makeRuntimeIdentity();

    manager.handleSocket(socket as any);
    socket.triggerMessage({
      type: "runtime_hello",
      runtimeId: did,
      nonce: "nonce",
      signature: Buffer.from(new Uint8Array(64)).toString("base64"),
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(socket.closed).toBe(true);
    expect(socket.sent.length).toBeGreaterThanOrEqual(1);
    expect(socket.sent[0].type).toBe("disconnect");
  });

  it("routes a proxied request and resolves on proxied_response", async () => {
    const manager = new TunnelManager(app);
    const socket = new MockWebSocket();
    const { did, privateKey } = makeRuntimeIdentity();
    const nonce = "nonce-2";

    manager.handleSocket(socket as any);
    socket.triggerMessage({
      type: "runtime_hello",
      runtimeId: did,
      nonce,
      signature: signHello(privateKey, nonce),
    });
    await new Promise((r) => setTimeout(r, 20));

    const requestPromise = manager.sendProxiedRequest(did, {
      requestId: "req-1",
      instanceId: "inst-1",
      method: "chat",
      body: { message: "hello" },
      headers: { "content-type": "application/json" },
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(socket.sent.length).toBeGreaterThanOrEqual(2);
    expect(socket.sent[1].type).toBe("proxied_request");

    const proxied = socket.sent[1];
    if (proxied.type !== "proxied_request") throw new Error("unexpected");

    socket.triggerMessage({
      type: "proxied_response",
      requestId: "req-1",
      payload: Array.from(
        Buffer.from(
          JSON.stringify({ status: 200, body: { reply: "hi" } }),
          "utf8",
        ),
      ),
    });

    const result = await requestPromise;
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ reply: "hi" });
  });

  it("returns Runtime not connected when no active tunnel", async () => {
    const manager = new TunnelManager(app);
    await expect(
      manager.sendProxiedRequest("did:key:zMissing", {
        requestId: "req-1",
        instanceId: "inst-1",
        method: "chat",
        body: {},
        headers: {},
      }),
    ).rejects.toThrow("Runtime not connected");
  });

  it("acks heartbeats and keeps connection alive", async () => {
    const manager = new TunnelManager(app);
    const socket = new MockWebSocket();
    const { did, privateKey } = makeRuntimeIdentity();
    const nonce = "nonce-3";

    manager.handleSocket(socket as any);
    socket.triggerMessage({
      type: "runtime_hello",
      runtimeId: did,
      nonce,
      signature: signHello(privateKey, nonce),
    });
    await new Promise((r) => setTimeout(r, 20));

    socket.triggerMessage({ type: "heartbeat", seq: 1 });
    await new Promise((r) => setTimeout(r, 20));

    const ack = socket.sent.find((m) => m.type === "heartbeat_ack");
    expect(ack).toBeDefined();
    if (ack && ack.type === "heartbeat_ack") {
      expect(ack.seq).toBe(1);
    }
  });

  // Regression tests for code-review findings

  it("cleans up pendingRequestIds after proxied_response (no ReferenceError)", async () => {
    const manager = new TunnelManager(app);
    const socket = new MockWebSocket();
    const { did, privateKey } = makeRuntimeIdentity();

    manager.handleSocket(socket as any);
    socket.triggerMessage({
      type: "runtime_hello",
      runtimeId: did,
      nonce: "nonce-cleanup",
      signature: signHello(privateKey, "nonce-cleanup"),
    });
    await new Promise((r) => setTimeout(r, 20));

    const requestPromise = manager.sendProxiedRequest(did, {
      requestId: "req-cleanup",
      instanceId: "inst-1",
      method: "chat",
      body: {},
      headers: {},
    });
    await new Promise((r) => setTimeout(r, 20));

    // Trigger response — this previously threw ReferenceError due to missing `conn` variable
    socket.triggerMessage({
      type: "proxied_response",
      requestId: "req-cleanup",
      payload: Array.from(
        Buffer.from(JSON.stringify({ status: 200, body: {} }), "utf8"),
      ),
    });

    await expect(requestPromise).resolves.toEqual({ status: 200, body: {} });
    expect(manager.isRuntimeConnected(did)).toBe(true);
  });

  it("cleans up pendingRequestIds on each stream_chunk", async () => {
    const manager = new TunnelManager(app);
    const socket = new MockWebSocket();
    const { did, privateKey } = makeRuntimeIdentity();

    manager.handleSocket(socket as any);
    socket.triggerMessage({
      type: "runtime_hello",
      runtimeId: did,
      nonce: "nonce-stream",
      signature: signHello(privateKey, "nonce-stream"),
    });
    await new Promise((r) => setTimeout(r, 20));

    const chunks: string[] = [];
    const streamPromise = manager.startStream(
      did,
      {
        requestId: "req-stream",
        instanceId: "inst-1",
        method: "stream",
        body: {},
        headers: {},
      },
      {
        onChunk: (c) => chunks.push(c),
        onEnd: () => {},
        onError: () => {},
      },
    );
    await new Promise((r) => setTimeout(r, 20));

    socket.triggerMessage({
      type: "stream_chunk",
      requestId: "req-stream",
      seq: 1,
      payload: Array.from(Buffer.from("chunk-1", "utf8")),
    });
    await new Promise((r) => setTimeout(r, 10));

    // pendingRequestIds should be cleaned up after each chunk to avoid leak
    const conn = (manager as any).connections.get(did);
    expect(conn.pendingRequestIds.has("req-stream")).toBe(false);

    socket.triggerMessage({
      type: "stream_end",
      requestId: "req-stream",
    });
    await streamPromise;
    expect(chunks).toContain("chunk-1");
  });

  it("clears the timeout timer when a proxied request completes normally", async () => {
    const manager = new TunnelManager(app);
    const socket = new MockWebSocket();
    const { did, privateKey } = makeRuntimeIdentity();

    manager.handleSocket(socket as any);
    socket.triggerMessage({
      type: "runtime_hello",
      runtimeId: did,
      nonce: "nonce-timer",
      signature: signHello(privateKey, "nonce-timer"),
    });
    await new Promise((r) => setTimeout(r, 20));

    const requestPromise = manager.sendProxiedRequest(
      did,
      {
        requestId: "req-timer",
        instanceId: "inst-1",
        method: "chat",
        body: {},
        headers: {},
      },
      100, // short timeout so we can observe timer behavior
    );
    await new Promise((r) => setTimeout(r, 20));

    const pending = (manager as any).pendingRequests.get("req-timer");
    expect(pending?.timer).toBeDefined();

    socket.triggerMessage({
      type: "proxied_response",
      requestId: "req-timer",
      payload: Array.from(
        Buffer.from(JSON.stringify({ status: 200, body: {} }), "utf8"),
      ),
    });

    await requestPromise;

    // Timer should be cleared after normal completion
    const pendingAfter = (manager as any).pendingRequests.get("req-timer");
    expect(pendingAfter).toBeUndefined();
  });

  it("resolves startStream even when sink.onEnd throws", async () => {
    const manager = new TunnelManager(app);
    const socket = new MockWebSocket();
    const { did, privateKey } = makeRuntimeIdentity();

    manager.handleSocket(socket as any);
    socket.triggerMessage({
      type: "runtime_hello",
      runtimeId: did,
      nonce: "nonce-sink-err",
      signature: signHello(privateKey, "nonce-sink-err"),
    });
    await new Promise((r) => setTimeout(r, 20));

    const errors: Error[] = [];
    const streamPromise = manager.startStream(
      did,
      {
        requestId: "req-sink-err",
        instanceId: "inst-1",
        method: "stream",
        body: {},
        headers: {},
      },
      {
        onChunk: () => {},
        onEnd: () => {
          throw new Error("onEnd boom");
        },
        onError: (err) => errors.push(err),
      },
    );
    await new Promise((r) => setTimeout(r, 20));

    socket.triggerMessage({
      type: "proxied_response",
      requestId: "req-sink-err",
      payload: Array.from(
        Buffer.from(JSON.stringify({ status: 200, body: "ok" }), "utf8"),
      ),
    });

    // Should resolve even though onEnd threw
    await expect(streamPromise).resolves.toBeUndefined();
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });
});
