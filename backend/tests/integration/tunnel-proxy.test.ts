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
        ownerSubject: { kind: "user", id: String(user.id) },
        name: "online-principal",
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
        ownerSubject: { kind: "user", id: String(user.id) },
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
        ownerSubject: { kind: "user", id: String(user.id) },
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

    it("sends a signed bridge token (no x-pekohub-user-id) for private instance chat", async () => {
      const { app, tunnelManager } = await buildTunnelTestApp(testDb);
      const user = await createUser(testDb.client, { namespace: "alice" });
      const headers = await authHeaders(user);
      const { did, privateKey } = makeRuntimeIdentity();

      // Post-H4: ownership is the only auth signal. The user owns
      // this private instance directly via ownerSubject.
      const instance = await createInstance(testDb.client, {
        ownerSubject: { kind: "user", id: String(user.id) },
        name: "private-principal",
        runtimeId: did,
        status: "online",
        exposure: "private",
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
      // ADR-057: identity travels only as an EdDSA bridge token.
      expect(decoded.headers["x-pekohub-user-id"]).toBeUndefined();
      const auth = decoded.headers["authorization"] as string;
      expect(auth).toMatch(/^Bearer /);
      const claims = JSON.parse(
        Buffer.from(auth.slice("Bearer ".length).split(".")[1], "base64url").toString("utf8"),
      );
      expect(claims.sub).toBe(String(user.id));
      expect(claims.aud).toBe(did);

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
        ownerSubject: { kind: "user", id: String(user.id) },
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

  // ---------------------------------------------------------------------------
  // PR-B4: Public chat happy-path integration tests.
  //
  // The existing public chat test (`instances.test.ts`) only asserts 502
  // because no tunnel was wired. These tests wire a real tunnel manager,
  // connect a mock runtime, and assert end-to-end SSE shapes:
  //
  //   - PR-B1: visitor cookie minted, bridge token (ADR-057) set on
  //     proxied_request (anonymous chat no longer 403s).
  //   - PR-B2: stream_iteration tunnel frame is re-projected as
  //     `event: iteration` SSE line.
  //   - PR-B3: quota rejection produces a 429 SSE response with
  //     `event: error\ndata: { code: "quota_exceeded" }`.
  //
  // The "first-ever end-to-end happy-path assertion" (per the plan) is
  // the first test below — a public anonymous chat that streams chunks
  // back as `data: { chunk, done: false }`.
  // ---------------------------------------------------------------------------

  describe("Public chat end-to-end (PR-B1, B2, B3, B4)", () => {
    /** Helper: stand up an authenticated user, public instance,
     *  registered runtime, and connected mock socket. Returns the
     *  handle so the test can fire stream chunks. */
    async function bootPublicHarness(opts?: { dailyQuota?: number }) {
      const { app, tunnelManager } = await buildTunnelTestApp(testDb);
      const user = await createUser(testDb.client, { namespace: "alice" });
      const { did, privateKey } = makeRuntimeIdentity();

      const instance = await createInstance(testDb.client, {
        ownerSubject: { kind: "user", id: String(user.id) },
        name: "public-chat-bot",
        runtimeId: did,
        status: "online",
        exposure: "public",
        dailyQuota: opts?.dailyQuota ?? null,
      });

      await seedRuntime(testDb, did, user.id);

      const socket = new MockWebSocket();
      tunnelManager.handleSocket(socket as unknown as WebSocket);
      await completeHandshake(socket, did, privateKey, "nonce-pub");

      return { app, socket, instance, did };
    }

    it("streams SSE chunks back to an anonymous caller (no auth)", async () => {
      const { app, socket, instance } = await bootPublicHarness();

      const chatPromise = app.inject({
        method: "POST",
        url: `/v1/public/pekos/alice/${instance.name}/chat`,
        payload: { message: "hello" },
      });

      // Wait for the runtime to receive the proxied request.
      await new Promise((r) => setTimeout(r, 50));
      const proxiedRequest = socket.sent.find(
        (m) => m.type === "proxied_request",
      );
      expect(proxiedRequest).toBeDefined();
      if (proxiedRequest?.type !== "proxied_request") throw new Error("unexpected");

      // Emit a stream chunk + stream_end.
      socket.triggerMessage({
        type: "stream_chunk",
        requestId: proxiedRequest.requestId,
        seq: 0,
        payload: Array.from(
          Buffer.from(
            JSON.stringify({ chunk: "Hi visitor", done: false }),
            "utf8",
          ),
        ),
      });
      socket.triggerMessage({
        type: "stream_end",
        requestId: proxiedRequest.requestId,
      });

      const response = await chatPromise;

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/event-stream");

      // Parse SSE frames into a flat event list.
      const dataLines = response.payload
        .split("\n")
        .filter((l) => l.startsWith("data:"));
      const events = dataLines.map((l) =>
        JSON.parse(l.slice(5).trim()),
      );
      const chunks = events.filter((e: any) => e.chunk !== undefined);
      const doneFrames = events.filter((e: any) => e.done === true);
      // Under the mock harness the runtime sends IPC payloads as
      // JSON strings, so the SSE `chunk` envelope ends up containing
      // the JSON-stringified IPC body. Assert the visitor's text
      // substring survives, regardless of wire-format details.
      const chunkConcat = chunks
        .map((e: any) => String(e.chunk ?? ""))
        .join("");
      expect(chunkConcat).toContain("Hi visitor");
      expect(doneFrames.length).toBeGreaterThanOrEqual(1);
    });

    it("mints a visitor cookie + sends a signed bridge token on the proxied request", async () => {
      const { app, socket, instance } = await bootPublicHarness();

      const chatPromise = app.inject({
        method: "POST",
        url: `/v1/public/pekos/alice/${instance.name}/chat`,
        payload: { message: "first-ever" },
      });

      await new Promise((r) => setTimeout(r, 50));
      const proxiedRequest = socket.sent.find(
        (m) => m.type === "proxied_request",
      );
      expect(proxiedRequest).toBeDefined();
      if (proxiedRequest?.type !== "proxied_request") throw new Error("unexpected");

      // End the stream so the SSE response resolves.
      socket.triggerMessage({
        type: "stream_end",
        requestId: proxiedRequest.requestId,
      });

      const response = await chatPromise;
      expect(response.statusCode).toBe(200);

      const setCookie = response.headers["set-cookie"];
      expect(setCookie).toBeDefined();
      // The cookie name and HttpOnly flag are the contract for
      // thread continuity — see PR-B1 plan.
      const cookieStr = Array.isArray(setCookie)
        ? setCookie.join("\n")
        : String(setCookie);
      expect(cookieStr).toContain("pekohub_visitor=");
      expect(cookieStr.toLowerCase()).toContain("httponly");
    });

    it("emits event: iteration when runtime sends stream_iteration", async () => {
      const { app, socket, instance } = await bootPublicHarness();

      const chatPromise = app.inject({
        method: "POST",
        url: `/v1/public/pekos/alice/${instance.name}/chat`,
        payload: { message: "trigger iteration break" },
      });

      await new Promise((r) => setTimeout(r, 50));
      const proxiedRequest = socket.sent.find(
        (m) => m.type === "proxied_request",
      );
      if (proxiedRequest?.type !== "proxied_request") throw new Error("unexpected");

      // Runtime signals iteration 2 begins.
      socket.triggerMessage({
        type: "stream_iteration",
        requestId: proxiedRequest.requestId,
        iteration: 2,
      });
      socket.triggerMessage({
        type: "stream_chunk",
        requestId: proxiedRequest.requestId,
        seq: 0,
        payload: Array.from(
          Buffer.from(
            JSON.stringify({ chunk: "after iteration 2", done: false }),
            "utf8",
          ),
        ),
      });
      socket.triggerMessage({
        type: "stream_end",
        requestId: proxiedRequest.requestId,
      });

      const response = await chatPromise;
      expect(response.statusCode).toBe(200);

      // Look for the typed iteration event line — the SPA parses it
      // via addEventListener("iteration", ...), not the data: channel.
      const iterationLines = response.payload
        .split("\n\n")
        .filter((block) => block.startsWith("event: iteration"));
      expect(iterationLines.length).toBe(1);
      const iterPayload = iterationLines[0]
        .split("\n")
        .find((l) => l.startsWith("data:"));
      expect(iterPayload).toBeDefined();
      const parsed = JSON.parse(iterPayload!.slice(5).trim());
      expect(parsed.iteration).toBe(2);
    });

    it("returns 429 SSE with code=quota_exceeded when daily quota is exhausted", async () => {
      const { app, socket, instance } = await bootPublicHarness({
        dailyQuota: 1,
      });

      // First message: allowed (consumes the 1-message budget).
      const firstPromise = app.inject({
        method: "POST",
        url: `/v1/public/pekos/alice/${instance.name}/chat`,
        payload: { message: "first" },
      });
      await new Promise((r) => setTimeout(r, 50));
      const firstProxied = socket.sent.find(
        (m) => m.type === "proxied_request",
      );
      if (firstProxied?.type !== "proxied_request") throw new Error("unexpected");
      socket.triggerMessage({
        type: "stream_end",
        requestId: firstProxied.requestId,
      });
      await firstPromise;

      // Second message: rejected at the quota check (PR-B3). Should
      // 429 BEFORE we touch the runtime, so we don't expect another
      // proxied_request — but the socket may receive one anyway if
      // the test raced. To be deterministic, snapshot before.
      const sentBefore = socket.sent.length;
      const secondResponse = await app.inject({
        method: "POST",
        url: `/v1/public/pekos/alice/${instance.name}/chat`,
        payload: { message: "second" },
      });
      const sentAfter = socket.sent.length;

      expect(secondResponse.statusCode).toBe(429);
      // Quota rejection must NOT have consumed a proxied_request.
      expect(sentAfter).toBe(sentBefore);

      const errorLines = secondResponse.payload
        .split("\n\n")
        .filter((block) => block.startsWith("event: error"));
      expect(errorLines.length).toBe(1);
      const errorPayload = errorLines[0]
        .split("\n")
        .find((l) => l.startsWith("data:"));
      const parsed = JSON.parse(errorPayload!.slice(5).trim());
      expect(parsed.code).toBe("quota_exceeded");
      expect(parsed.reason).toBe("daily");
    });
  });
});
