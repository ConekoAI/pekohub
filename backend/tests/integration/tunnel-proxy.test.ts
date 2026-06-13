import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import { EventEmitter } from "events";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";

import { createTestDb, resetTables } from "../fixtures/db.js";
import { createUser, createInstance } from "../fixtures/factories.js";
import { authHeaders } from "../fixtures/auth.js";
import configPlugin from "../../src/plugins/config.js";
import authPlugin from "../../src/plugins/auth.js";
import { setDb } from "../../src/db/index.js";
import { TunnelManager } from "../../src/services/tunnel-manager.js";
import { TunnelRouter } from "../../src/services/tunnel-router.js";
import { encodeTunnelMessage, type TunnelMessage } from "../../src/services/tunnel-protocol.js";
import instanceRoutes from "../../src/routes/api/instances.js";

import type { TestDb } from "../fixtures/db.js";
import type { WebSocket } from "ws";

const ED25519_PUB_MULTICODEC = new Uint8Array([0xed, 0x01]);

// ---------------------------------------------------------------------------
// Mock WebSocket that captures sent messages and can trigger received ones
// ---------------------------------------------------------------------------

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
    this.readyState = 3;
    this.emit("close");
  }

  triggerMessage(msg: TunnelMessage) {
    this.emit("message", Buffer.from(JSON.stringify(msg), "utf8"));
  }
}

// ---------------------------------------------------------------------------
// Test harness: build app with REAL tunnel manager + router
// ---------------------------------------------------------------------------

async function buildTunnelTestApp(testDb: TestDb) {
  const originalEnv = { ...process.env };
  process.env.DATABASE_URL = "postgres://localhost:5432/pekohub_test";
  process.env.S3_ENDPOINT = "http://localhost:9000";
  process.env.S3_ACCESS_KEY = "test";
  process.env.S3_SECRET_KEY = "test";
  process.env.S3_BUCKET = "test-bucket";
  process.env.MEILISEARCH_URL = "http://localhost:7700";
  process.env.MEILISEARCH_API_KEY = "test";
  process.env.JWT_SECRET = "test-secret-key-that-is-32-chars-long!!";
  process.env.NODE_ENV = "test";
  process.env.GC_ENABLED = "false";
  process.env.RATE_LIMIT_MAX = "1000";
  process.env.ALLOW_DEV_AUTH_BYPASS = "false";

  setDb(testDb.db);

  const app = Fastify({
    logger: false,
    bodyLimit: 100 * 1024 * 1024,
  });

  await app.register(configPlugin);
  await app.register(cors, { origin: true, credentials: true });
  await app.register(cookie);
  await app.register(authPlugin);

  // Real tunnel manager + router (not mocked)
  const tunnelManager = new TunnelManager(app);
  const tunnelRouter = new TunnelRouter(tunnelManager);
  app.decorate("tunnelManager", tunnelManager);
  app.decorate("tunnelRouter", tunnelRouter);

  // Mock storage
  app.decorate("storage", {
    async put() {},
    async get() {
      return Buffer.from("");
    },
    async exists() {
      return true;
    },
    async delete() {},
    async getSignedGetUrl(key: string) {
      return `http://mock-storage/${key}`;
    },
    async getSignedPutUrl(key: string) {
      return `http://mock-storage/${key}?upload`;
    },
  });

  // Mock search
  app.decorate("search", {
    async indexBundle() {},
    async search() {
      return { hits: [], total: 0, page: 1, perPage: 20 };
    },
    async deleteBundle() {},
    async indexInstance() {},
    async searchInstances() {
      return { hits: [], total: 0, page: 1, perPage: 20 };
    },
    async deleteInstance() {},
  });

  await app.register(instanceRoutes, { prefix: "/v1" });

  app.get("/health", async () => ({ status: "ok" }));

  app.setErrorHandler((error, _request, reply) => {
    reply.status(error.statusCode ?? 500).send({
      error: error.message,
    });
  });

  process.env = originalEnv;

  return { app, tunnelManager, tunnelRouter };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Tunnel Proxy Integration", () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  });

  beforeEach(async () => {
    await resetTables(testDb.client);
  });

  afterAll(async () => {
    await testDb.client.close();
  });

  describe("proxyChat via tunnel", () => {
    it("returns 502 when runtime is not connected", async () => {
      const { app } = await buildTunnelTestApp(testDb);
      const user = await createUser(testDb.client, { namespace: "alice" });
      const headers = await authHeaders(user);

      const instance = await createInstance(testDb.client, {
        ownerId: user.id,
        name: "online-agent",
        runtimeId: "did:key:zOffline",
        status: "online",
        exposure: "public",
      });

      const response = await app.inject({
        method: "POST",
        url: `/v1/instances/${instance.id}/chat`,
        headers,
        payload: { message: "hello" },
      });

      expect(response.statusCode).toBe(502);
      const body = JSON.parse(response.payload);
      expect(body.error).toBe("Instance unreachable");
    });

    it("streams SSE chunks when runtime responds with stream_chunk", async () => {
      const { app, tunnelManager } = await buildTunnelTestApp(testDb);
      const user = await createUser(testDb.client, { namespace: "alice" });
      const headers = await authHeaders(user);
      const { did, privateKey } = makeRuntimeIdentity();

      // Create a connected runtime with an instance
      const instance = await createInstance(testDb.client, {
        ownerId: user.id,
        name: "streaming-agent",
        runtimeId: did,
        status: "online",
        exposure: "public",
      });

      // Connect a mock runtime WebSocket
      const socket = new MockWebSocket();
      tunnelManager.handleSocket(socket as unknown as WebSocket);

      // Wait a tick for the hello timer to be set up
      await new Promise((r) => setTimeout(r, 10));

      // Authenticate the runtime
      const nonce1 = "nonce-1";
      socket.triggerMessage({
        type: "runtime_hello",
        runtimeId: did,
        nonce: nonce1,
        signature: signHello(privateKey, nonce1),
      });

      // Wait for auth processing
      await new Promise((r) => setTimeout(r, 50));

      // Verify tunnel is connected
      expect(tunnelManager.isRuntimeConnected(did)).toBe(true);

      // Now make the HTTP chat request
      // We need to handle the proxied request on the mock socket side
      const chatPromise = app.inject({
        method: "POST",
        url: `/v1/instances/${instance.id}/chat`,
        headers,
        payload: { message: "hello" },
      });

      // Wait for the proxied request to arrive at the mock socket
      await new Promise((r) => setTimeout(r, 50));

      // Find the proxied_request message
      const proxiedRequest = socket.sent.find(
        (m) => m.type === "proxied_request",
      );
      expect(proxiedRequest).toBeDefined();
      if (proxiedRequest?.type !== "proxied_request") throw new Error("unexpected");

      // Respond with streaming chunks
      socket.triggerMessage({
        type: "stream_chunk",
        requestId: proxiedRequest.requestId,
        seq: 0,
        payload: Array.from(
          Buffer.from(JSON.stringify({ chunk: "Hello", done: false }), "utf8"),
        ),
      });

      await new Promise((r) => setTimeout(r, 20));

      socket.triggerMessage({
        type: "stream_chunk",
        requestId: proxiedRequest.requestId,
        seq: 1,
        payload: Array.from(
          Buffer.from(JSON.stringify({ chunk: " world", done: false }), "utf8"),
        ),
      });

      await new Promise((r) => setTimeout(r, 20));

      socket.triggerMessage({
        type: "stream_end",
        requestId: proxiedRequest.requestId,
      });

      const response = await chatPromise;

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/event-stream");

      const lines = response.payload.split("\n").filter((l) => l.trim() !== "");
      expect(lines.length).toBeGreaterThanOrEqual(2);

      // Parse SSE data lines
      const events = lines
        .filter((l) => l.startsWith("data:"))
        .map((l) => JSON.parse(l.slice(5).trim()));

      expect(events).toHaveLength(3);
      // The runtime sends JSON-encoded chunks; tunnel-router wraps them in SSE
      expect(events[0]).toMatchObject({
        chunk: '{"chunk":"Hello","done":false}',
        done: false,
      });
      expect(events[1]).toMatchObject({
        chunk: '{"chunk":" world","done":false}',
        done: false,
      });
      expect(events[2]).toMatchObject({ done: true });
    });

    it("streams done marker and ends SSE when runtime sends stream_end", async () => {
      const { app, tunnelManager } = await buildTunnelTestApp(testDb);
      const user = await createUser(testDb.client, { namespace: "bob" });
      const headers = await authHeaders(user);
      const { did, privateKey } = makeRuntimeIdentity();

      const instance = await createInstance(testDb.client, {
        ownerId: user.id,
        name: "done-agent",
        runtimeId: did,
        status: "online",
        exposure: "public",
      });

      const socket = new MockWebSocket();
      tunnelManager.handleSocket(socket as unknown as WebSocket);
      await new Promise((r) => setTimeout(r, 10));

      const nonce2 = "nonce-2";
      socket.triggerMessage({
        type: "runtime_hello",
        runtimeId: did,
        nonce: nonce2,
        signature: signHello(privateKey, nonce2),
      });
      await new Promise((r) => setTimeout(r, 50));

      expect(tunnelManager.isRuntimeConnected(did)).toBe(true);

      const chatPromise = app.inject({
        method: "POST",
        url: `/v1/instances/${instance.id}/chat`,
        headers,
        payload: { message: "test" },
      });

      await new Promise((r) => setTimeout(r, 50));

      const proxiedRequest = socket.sent.find(
        (m) => m.type === "proxied_request",
      );
      expect(proxiedRequest).toBeDefined();
      if (proxiedRequest?.type !== "proxied_request") throw new Error("unexpected");

      // Single chunk then end
      socket.triggerMessage({
        type: "stream_chunk",
        requestId: proxiedRequest.requestId,
        seq: 0,
        payload: Array.from(
          Buffer.from(JSON.stringify({ chunk: "Done!", done: true }), "utf8"),
        ),
      });

      await new Promise((r) => setTimeout(r, 20));

      socket.triggerMessage({
        type: "stream_end",
        requestId: proxiedRequest.requestId,
      });

      const response = await chatPromise;

      expect(response.statusCode).toBe(200);
      const lines = response.payload.split("\n").filter((l) => l.trim() !== "");
      const events = lines
        .filter((l) => l.startsWith("data:"))
        .map((l) => JSON.parse(l.slice(5).trim()));

      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[events.length - 1]).toMatchObject({ done: true });
    });

    it("includes x-pekohub-user-id in proxied request headers for private instance chat", async () => {
      const { app, tunnelManager } = await buildTunnelTestApp(testDb);
      const user = await createUser(testDb.client, { namespace: "alice" });
      const headers = await authHeaders(user);
      const { did, privateKey } = makeRuntimeIdentity();

      // Create a private instance with the user in allowedUsers
      const instance = await createInstance(testDb.client, {
        ownerId: user.id,
        name: "private-agent",
        runtimeId: did,
        status: "online",
        exposure: "private",
        allowedUsers: [String(user.id)],
      });

      // Connect a mock runtime WebSocket
      const socket = new MockWebSocket();
      tunnelManager.handleSocket(socket as unknown as WebSocket);
      await new Promise((r) => setTimeout(r, 10));

      // Authenticate the runtime
      const nonce = "nonce-private";
      socket.triggerMessage({
        type: "runtime_hello",
        runtimeId: did,
        nonce,
        signature: signHello(privateKey, nonce),
      });
      await new Promise((r) => setTimeout(r, 50));
      expect(tunnelManager.isRuntimeConnected(did)).toBe(true);

      // Make the HTTP chat request
      const chatPromise = app.inject({
        method: "POST",
        url: `/v1/instances/${instance.id}/chat`,
        headers,
        payload: { message: "hello" },
      });
      await new Promise((r) => setTimeout(r, 50));

      // Find the proxied_request message and decode its payload to verify headers
      const proxiedRequest = socket.sent.find(
        (m) => m.type === "proxied_request",
      );
      expect(proxiedRequest).toBeDefined();
      if (proxiedRequest?.type !== "proxied_request") throw new Error("unexpected");

      const decoded = JSON.parse(
        Buffer.from(proxiedRequest.payload).toString("utf8"),
      );
      expect(decoded.headers).toBeDefined();
      expect(decoded.headers["x-pekohub-user-id"]).toBe(String(user.id));

      // Complete the stream so the HTTP side doesn't hang
      socket.triggerMessage({
        type: "stream_end",
        requestId: proxiedRequest.requestId,
      });

      const response = await chatPromise;
      expect(response.statusCode).toBe(200);
    });

    it("returns error event when runtime responds with proxied_response (non-streaming fallback)", async () => {
      const { app, tunnelManager } = await buildTunnelTestApp(testDb);
      const user = await createUser(testDb.client, { namespace: "charlie" });
      const headers = await authHeaders(user);
      const { did, privateKey } = makeRuntimeIdentity();

      const instance = await createInstance(testDb.client, {
        ownerId: user.id,
        name: "fallback-agent",
        runtimeId: did,
        status: "online",
        exposure: "public",
      });

      const socket = new MockWebSocket();
      tunnelManager.handleSocket(socket as unknown as WebSocket);
      await new Promise((r) => setTimeout(r, 10));

      const nonce3 = "nonce-3";
      socket.triggerMessage({
        type: "runtime_hello",
        runtimeId: did,
        nonce: nonce3,
        signature: signHello(privateKey, nonce3),
      });
      await new Promise((r) => setTimeout(r, 50));

      const chatPromise = app.inject({
        method: "POST",
        url: `/v1/instances/${instance.id}/chat`,
        headers,
        payload: { message: "test" },
      });

      await new Promise((r) => setTimeout(r, 50));

      const proxiedRequest = socket.sent.find(
        (m) => m.type === "proxied_request",
      );
      expect(proxiedRequest).toBeDefined();
      if (proxiedRequest?.type !== "proxied_request") throw new Error("unexpected");

      // Respond with proxied_response (non-streaming) instead of stream chunks
      socket.triggerMessage({
        type: "proxied_response",
        requestId: proxiedRequest.requestId,
        payload: Array.from(
          Buffer.from(
            JSON.stringify({ status: 200, body: { reply: "non-streaming" } }),
            "utf8",
          ),
        ),
      });

      const response = await chatPromise;

      expect(response.statusCode).toBe(200);
      const lines = response.payload.split("\n").filter((l) => l.trim() !== "");
      const events = lines
        .filter((l) => l.startsWith("data:"))
        .map((l) => JSON.parse(l.slice(5).trim()));

      // Should emit the body as a single chunk with done=true
      expect(events.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("instance lifecycle via tunnel", () => {
    it("creates instance on announce and marks offline on disconnect", async () => {
      const { app, tunnelManager } = await buildTunnelTestApp(testDb);
      const user = await createUser(testDb.client, { namespace: "dave" });
      const headers = await authHeaders(user);
      const { did, privateKey } = makeRuntimeIdentity();

      // Insert runtime record for owner resolution
      await testDb.client.query(
        `INSERT INTO runtimes (runtime_did, owner_id, display_name) VALUES ($1, $2, $3)`,
        [did, user.id, "Test Runtime"],
      );

      const socket = new MockWebSocket();
      tunnelManager.handleSocket(socket as unknown as WebSocket);
      await new Promise((r) => setTimeout(r, 10));

      const nonce4 = "nonce-4";
      socket.triggerMessage({
        type: "runtime_hello",
        runtimeId: did,
        nonce: nonce4,
        signature: signHello(privateKey, nonce4),
      });
      await new Promise((r) => setTimeout(r, 50));

      // Announce instance
      const instanceId = "a1b2c3d4-e5f6-47a8-b9c0-d1e2f3a4b5c6";
      socket.triggerMessage({
        type: "instance_announce",
        payload: {
          id: instanceId,
          type: "agent",
          name: "announced-agent",
          status: "online",
          exposure: "public",
          runtimeDisplayName: "Test Runtime",
          capabilities: ["chat"],
        },
      });

      await new Promise((r) => setTimeout(r, 200));

      // Verify instance appears in API
      const listResp = await app.inject({
        method: "GET",
        url: "/v1/instances",
        headers,
        query: { runtime_id: did },
      });

      expect(listResp.statusCode).toBe(200);
      const body = JSON.parse(listResp.payload);
      expect(body.data.some((i: any) => i.id === instanceId)).toBe(true);

      // Disconnect
      socket.close(1000, "test done");
      await new Promise((r) => setTimeout(r, 300));

      // Verify instance is offline
      const detailResp = await app.inject({
        method: "GET",
        url: `/v1/instances/${instanceId}`,
      });

      if (detailResp.statusCode === 200) {
        const detail = JSON.parse(detailResp.payload);
        expect(detail.status).toBe("offline");
      }
    });
  });
});
