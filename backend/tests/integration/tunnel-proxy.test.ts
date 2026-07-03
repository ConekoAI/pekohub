import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";

import { createTestDb, resetTables } from "../fixtures/db.js";
import { createUser, createInstance } from "../fixtures/factories.js";
import { authHeaders } from "../fixtures/auth.js";
import {
  MockWebSocket,
  completeHandshake,
  seedRuntime,
  makeRuntimeIdentity,
  signHello,
} from "../fixtures/tunnel.js";
import { buildTunnelTestApp } from "../fixtures/tunnel-app.js";

import type { TestDb } from "../fixtures/db.js";
import type { WebSocket } from "ws";

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

      // Allowlist: pekohub#1 requires the runtime to be in the
      // `runtimes` table before the handshake can complete.
      await seedRuntime(testDb, did, user.id);

      // Connect a mock runtime WebSocket
      const socket = new MockWebSocket();
      tunnelManager.handleSocket(socket as unknown as WebSocket);

      // Run the full handshake (hello → challenge → ack)
      await completeHandshake(socket, did, privateKey, "nonce-1");

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
      await seedRuntime(testDb, did, user.id);

      const socket = new MockWebSocket();
      tunnelManager.handleSocket(socket as unknown as WebSocket);

      await completeHandshake(socket, did, privateKey, "nonce-2");

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

      // Create a private instance with the user in allowedPrincipals
      const instance = await createInstance(testDb.client, {
        ownerId: user.id,
        name: "private-agent",
        runtimeId: did,
        status: "online",
        exposure: "private",
        allowedPrincipals: [String(user.id)],
      });

      // Allowlist for the handshake (issue #1)
      await seedRuntime(testDb, did, user.id);

      // Connect a mock runtime WebSocket
      const socket = new MockWebSocket();
      tunnelManager.handleSocket(socket as unknown as WebSocket);

      // Full handshake
      await completeHandshake(socket, did, privateKey, "nonce-private");
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
      await seedRuntime(testDb, did, user.id);

      const socket = new MockWebSocket();
      tunnelManager.handleSocket(socket as unknown as WebSocket);

      await completeHandshake(socket, did, privateKey, "nonce-3");

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

      // Allowlist: insert runtime record for handshake (issue #1)
      // and owner resolution.
      await seedRuntime(testDb, did, user.id, "Test Runtime");

      const socket = new MockWebSocket();
      tunnelManager.handleSocket(socket as unknown as WebSocket);

      await completeHandshake(socket, did, privateKey, "nonce-4");

      // Announce instance
      const instanceId = "a1b2c3d4-e5f6-47a8-b9c0-d1e2f3a4b5c6";
      socket.triggerMessage({
        type: "instance_announce",
        payload: {
          id: instanceId,
          type: "principal",
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

  describe("pekohub#1 allowlist", () => {
    it("closes with 1008 within 1s for an unknown runtime DID", async () => {
      const { tunnelManager } = await buildTunnelTestApp(testDb);
      // NOTE: no seedRuntime() — the runtime is NOT in the runtimes table
      const { did, privateKey } = makeRuntimeIdentity();
      const socket = new MockWebSocket();
      tunnelManager.handleSocket(socket as unknown as WebSocket);

      const start = Date.now();
      socket.triggerMessage({
        type: "runtime_hello",
        runtimeId: did,
        nonce: "nonce-unknown",
        signature: signHello(privateKey, "nonce-unknown"),
      });

      // Wait up to 1s for the close (acceptance criterion)
      const deadline = start + 1_000;
      while (!socket.closed && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      const elapsed = Date.now() - start;

      expect(socket.closed).toBe(true);
      expect(socket.closeCode).toBe(1008);
      expect(elapsed).toBeLessThan(1_000);
      const reason = socket.closeReason ?? "";
      expect(reason).toMatch(/unknown runtime/);
      // No challenge, no ready
      expect(socket.sent.some((m) => m.type === "tunnel_challenge")).toBe(false);
      expect(socket.sent.some((m) => m.type === "tunnel_ready")).toBe(false);
    });
  });
});
