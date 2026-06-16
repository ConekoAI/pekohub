import { describe, it, expect, beforeEach, vi } from "vitest";
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

/**
 * Run a complete handshake against a `MockWebSocket`: send the
 * runtime_hello, wait for the server-issued `tunnel_challenge`, send
 * back the signed ack, and return when the socket is "ready" (a
 * `tunnel_ready` has been received).
 *
 * The allowlist check is stubbed in the test to either allow or deny
 * the runtime — the handshake itself is the same either way.
 */
async function completeHandshake(
  manager: TunnelManager,
  socket: MockWebSocket,
  did: string,
  privateKey: Uint8Array,
  helloNonce = "nonce-1",
): Promise<TunnelMessage[]> {
  socket.triggerMessage({
    type: "runtime_hello",
    runtimeId: did,
    nonce: helloNonce,
    signature: signHello(privateKey, helloNonce),
  });
  // Wait for the server to send `tunnel_challenge`
  for (let i = 0; i < 50 && !socket.sent.some((m) => m.type === "tunnel_challenge"); i++) {
    await new Promise((r) => setTimeout(r, 2));
  }
  const challenge = socket.sent.find((m) => m.type === "tunnel_challenge");
  if (!challenge || challenge.type !== "tunnel_challenge") {
    throw new Error("Server did not send tunnel_challenge");
  }
  // Sign the challenge nonce and ack
  socket.triggerMessage({
    type: "tunnel_challenge_ack",
    nonce: challenge.nonce,
    signature: signHello(privateKey, challenge.nonce),
  });
  // Wait for `tunnel_ready`
  for (let i = 0; i < 50 && !socket.sent.some((m) => m.type === "tunnel_ready"); i++) {
    await new Promise((r) => setTimeout(r, 2));
  }
  return socket.sent;
}

/** Stub the allowlist to allow the given DID. */
function allowRuntime(manager: TunnelManager, did: string) {
  vi.spyOn(manager as any, "isRuntimeAllowed").mockImplementation(
    async (id: string) => id === did,
  );
  // No-op for the lastSeenAt bump so unit tests don't need a DB.
  vi.spyOn(manager as any, "recordRuntimeConnected").mockResolvedValue(
    undefined,
  );
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
    allowRuntime(manager, did);

    manager.handleSocket(socket as any);
    await completeHandshake(manager, socket, did, privateKey);

    expect(socket.sent.some((m) => m.type === "tunnel_challenge")).toBe(true);
    expect(socket.sent.some((m) => m.type === "tunnel_ready")).toBe(true);
    expect(socket.closed).toBe(false);
  });

  it("rejects an invalid RuntimeHello signature and closes socket", async () => {
    const manager = new TunnelManager(app);
    const socket = new MockWebSocket();
    const { did } = makeRuntimeIdentity();
    allowRuntime(manager, did);

    manager.handleSocket(socket as any);
    socket.triggerMessage({
      type: "runtime_hello",
      runtimeId: did,
      nonce: "nonce",
      signature: Buffer.from(new Uint8Array(64)).toString("base64"),
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(socket.closed).toBe(true);
    expect(socket.closeCode).toBe(1008);
    expect(socket.sent.some((m) => m.type === "disconnect")).toBe(true);
  });

  it("closes socket with 1008 for unknown runtime DID (issue #1 allowlist)", async () => {
    const manager = new TunnelManager(app);
    const socket = new MockWebSocket();
    const { did, privateKey } = makeRuntimeIdentity();
    // Allowlist returns false — the runtime is NOT in the runtimes table
    vi.spyOn(manager as any, "isRuntimeAllowed").mockResolvedValue(false);

    manager.handleSocket(socket as any);
    socket.triggerMessage({
      type: "runtime_hello",
      runtimeId: did,
      nonce: "nonce-unknown",
      signature: signHello(privateKey, "nonce-unknown"),
    });

    // Wait up to 1s for the close (acceptance criterion)
    const deadline = Date.now() + 1_000;
    while (!socket.closed && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }

    expect(socket.closed).toBe(true);
    expect(socket.closeCode).toBe(1008);
    const reason = socket.closeReason ?? "";
    expect(reason).toMatch(/unknown runtime/);
    // The runtime must NOT have received a challenge or a ready
    expect(socket.sent.some((m) => m.type === "tunnel_challenge")).toBe(false);
    expect(socket.sent.some((m) => m.type === "tunnel_ready")).toBe(false);
  });

  it("rejects a replayed tunnel_challenge_ack (same nonce reused)", async () => {
    const manager = new TunnelManager(app);
    const socket = new MockWebSocket();
    const { did, privateKey } = makeRuntimeIdentity();
    allowRuntime(manager, did);

    manager.handleSocket(socket as any);
    socket.triggerMessage({
      type: "runtime_hello",
      runtimeId: did,
      nonce: "nonce-replay",
      signature: signHello(privateKey, "nonce-replay"),
    });
    // Wait for the challenge
    for (let i = 0; i < 50 && !socket.sent.some((m) => m.type === "tunnel_challenge"); i++) {
      await new Promise((r) => setTimeout(r, 2));
    }
    const challenge = socket.sent.find(
      (m) => m.type === "tunnel_challenge",
    ) as Extract<TunnelMessage, { type: "tunnel_challenge" }>;
    expect(challenge).toBeDefined();

    // First ack — should succeed
    socket.triggerMessage({
      type: "tunnel_challenge_ack",
      nonce: challenge.nonce,
      signature: signHello(privateKey, challenge.nonce),
    });
    for (let i = 0; i < 50 && !socket.sent.some((m) => m.type === "tunnel_ready"); i++) {
      await new Promise((r) => setTimeout(r, 2));
    }
    expect(socket.sent.some((m) => m.type === "tunnel_ready")).toBe(true);
    const sentCountAfterReady = socket.sent.length;

    // Now a second socket on the same manager — different runtime id
    // but attempt to re-use the first runtime's challenge. We model
    // this by sending an ack with a nonce that was already consumed
    // (the manager no longer has it in its map). Easiest way: forge
    // an ack whose nonce doesn't match any pending challenge.
    const socket2 = new MockWebSocket();
    const { did: did2, privateKey: pk2 } = makeRuntimeIdentity();
    allowRuntime(manager, did2);
    manager.handleSocket(socket2 as any);
    socket2.triggerMessage({
      type: "runtime_hello",
      runtimeId: did2,
      nonce: "nonce2",
      signature: signHello(pk2, "nonce2"),
    });
    for (let i = 0; i < 50 && !socket2.sent.some((m) => m.type === "tunnel_challenge"); i++) {
      await new Promise((r) => setTimeout(r, 2));
    }
    // Ack with the FIRST runtime's consumed challenge nonce — must be
    // rejected because the manager's map has did2's nonce, not did's.
    socket2.triggerMessage({
      type: "tunnel_challenge_ack",
      nonce: challenge.nonce,
      signature: signHello(pk2, challenge.nonce),
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(socket2.closed).toBe(true);
    expect(socket2.closeCode).toBe(1008);
    expect(socket2.sent.some((m) => m.type === "tunnel_ready")).toBe(false);
    // The first socket should NOT have been affected
    expect(socket.sent.length).toBe(sentCountAfterReady);
  });

  it("rejects a tunnel_challenge_ack with mismatched nonce", async () => {
    const manager = new TunnelManager(app);
    const socket = new MockWebSocket();
    const { did, privateKey } = makeRuntimeIdentity();
    allowRuntime(manager, did);

    manager.handleSocket(socket as any);
    socket.triggerMessage({
      type: "runtime_hello",
      runtimeId: did,
      nonce: "nonce-mismatch",
      signature: signHello(privateKey, "nonce-mismatch"),
    });
    for (let i = 0; i < 50 && !socket.sent.some((m) => m.type === "tunnel_challenge"); i++) {
      await new Promise((r) => setTimeout(r, 2));
    }
    // Send an ack with a wrong nonce
    socket.triggerMessage({
      type: "tunnel_challenge_ack",
      nonce: "not-the-issued-nonce",
      signature: signHello(privateKey, "not-the-issued-nonce"),
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(socket.closed).toBe(true);
    expect(socket.closeCode).toBe(1008);
    expect(socket.sent.some((m) => m.type === "tunnel_ready")).toBe(false);
  });

  it("rejects a tunnel_challenge_ack with bad signature", async () => {
    const manager = new TunnelManager(app);
    const socket = new MockWebSocket();
    const { did, privateKey } = makeRuntimeIdentity();
    allowRuntime(manager, did);

    manager.handleSocket(socket as any);
    socket.triggerMessage({
      type: "runtime_hello",
      runtimeId: did,
      nonce: "nonce-bad-sig",
      signature: signHello(privateKey, "nonce-bad-sig"),
    });
    for (let i = 0; i < 50 && !socket.sent.some((m) => m.type === "tunnel_challenge"); i++) {
      await new Promise((r) => setTimeout(r, 2));
    }
    const challenge = socket.sent.find(
      (m) => m.type === "tunnel_challenge",
    ) as Extract<TunnelMessage, { type: "tunnel_challenge" }>;
    socket.triggerMessage({
      type: "tunnel_challenge_ack",
      nonce: challenge.nonce,
      signature: Buffer.from(new Uint8Array(64)).toString("base64"),
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(socket.closed).toBe(true);
    expect(socket.closeCode).toBe(1008);
    expect(socket.sent.some((m) => m.type === "tunnel_ready")).toBe(false);
  });

  it("routes a proxied request and resolves on proxied_response", async () => {
    const manager = new TunnelManager(app);
    const socket = new MockWebSocket();
    const { did, privateKey } = makeRuntimeIdentity();
    allowRuntime(manager, did);

    manager.handleSocket(socket as any);
    await completeHandshake(manager, socket, did, privateKey, "nonce-2");

    const requestPromise = manager.sendProxiedRequest(did, {
      requestId: "req-1",
      instanceId: "inst-1",
      method: "chat",
      body: { message: "hello" },
      headers: { "content-type": "application/json" },
    });

    await new Promise((r) => setTimeout(r, 20));
    const proxied = socket.sent.find((m) => m.type === "proxied_request");
    expect(proxied).toBeDefined();
    if (proxied?.type !== "proxied_request") throw new Error("unexpected");

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
    allowRuntime(manager, did);

    manager.handleSocket(socket as any);
    await completeHandshake(manager, socket, did, privateKey, "nonce-3");

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
    allowRuntime(manager, did);

    manager.handleSocket(socket as any);
    await completeHandshake(manager, socket, did, privateKey, "nonce-cleanup");

    const requestPromise = manager.sendProxiedRequest(did, {
      requestId: "req-cleanup",
      instanceId: "inst-1",
      method: "chat",
      body: {},
      headers: {},
    });
    await new Promise((r) => setTimeout(r, 20));

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
    allowRuntime(manager, did);

    manager.handleSocket(socket as any);
    await completeHandshake(manager, socket, did, privateKey, "nonce-stream");

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
    allowRuntime(manager, did);

    manager.handleSocket(socket as any);
    await completeHandshake(manager, socket, did, privateKey, "nonce-timer");

    const requestPromise = manager.sendProxiedRequest(
      did,
      {
        requestId: "req-timer",
        instanceId: "inst-1",
        method: "chat",
        body: {},
        headers: {},
      },
      100,
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

    const pendingAfter = (manager as any).pendingRequests.get("req-timer");
    expect(pendingAfter).toBeUndefined();
  });

  it("resolves startStream even when sink.onEnd throws", async () => {
    const manager = new TunnelManager(app);
    const socket = new MockWebSocket();
    const { did, privateKey } = makeRuntimeIdentity();
    allowRuntime(manager, did);

    manager.handleSocket(socket as any);
    await completeHandshake(manager, socket, did, privateKey, "nonce-sink-err");

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

    await expect(streamPromise).resolves.toBeUndefined();
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  it("propagates status_update messages on disconnect before marking offline", async () => {
    const manager = new TunnelManager(app);
    const socket = new MockWebSocket();
    const { did, privateKey } = makeRuntimeIdentity();
    allowRuntime(manager, did);

    manager.handleSocket(socket as any);
    await completeHandshake(manager, socket, did, privateKey, "nonce-disconnect");

    expect(manager.isRuntimeConnected(did)).toBe(true);

    const propagateSpy = vi
      .spyOn(manager as any, "propagateRuntimeOffline")
      .mockResolvedValue(undefined);

    socket.close();
    await new Promise((r) => setTimeout(r, 20));

    expect(manager.isRuntimeConnected(did)).toBe(false);
    expect(propagateSpy).toHaveBeenCalledTimes(1);
    expect(propagateSpy.mock.calls[0][0].runtimeId).toBe(did);

    propagateSpy.mockRestore();
  });

  it("does not throw when disconnecting a runtime with no instances", async () => {
    const manager = new TunnelManager(app);
    const socket = new MockWebSocket();
    const { did, privateKey } = makeRuntimeIdentity();
    allowRuntime(manager, did);

    manager.handleSocket(socket as any);
    await completeHandshake(manager, socket, did, privateKey, "nonce-no-instances");

    expect(manager.isRuntimeConnected(did)).toBe(true);

    const markOfflineSpy = vi
      .spyOn(manager as any, "markRuntimeOffline")
      .mockResolvedValue(undefined);

    await expect(
      (manager as any).propagateRuntimeOffline(
        (manager as any).connections.get(did),
      ),
    ).resolves.toBeUndefined();

    expect(markOfflineSpy).toHaveBeenCalledWith(did);

    markOfflineSpy.mockRestore();
  });
});
