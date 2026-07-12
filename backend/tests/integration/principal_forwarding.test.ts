/**
 * Cross-runtime a2a forwarding (pekohub issue #16).
 *
 * Pinned to the acceptance criteria from the issue:
 *
 *   - forward-success: signed PrincipalToPrincipalRequest from runtime A's tunnel
 *     reaches runtime B's tunnel verbatim; PrincipalToPrincipalResponse is
 *     correlated back to A.
 *   - source-allowlist-reject: `callerRuntimeId` mismatch → close A's
 *     tunnel + log, no message to B.
 *   - target-missing: unknown `targetPrincipalDid` → structured error
 *     response to caller.
 *   - target-offline: target runtime not connected → structured error
 *     response to caller.
 *   - forbidden: ACL denies → structured error response to caller.
 *   - response-correlation: target never replies → timeout error
 *     response to caller after TTL.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";

import { createTestDb, resetTables } from "../fixtures/db.js";
import { createUser, createInstance } from "../fixtures/factories.js";
import {
  MockWebSocket,
  completeHandshake,
  seedRuntime,
  makeRuntimeIdentity,
} from "../fixtures/tunnel.js";

import configPlugin from "../../src/plugins/config.js";
import authPlugin from "../../src/plugins/auth.js";
import { setDb } from "../../src/db/index.js";
import { TunnelManager } from "../../src/services/tunnel-manager.js";
import { metrics, CounterName } from "../../src/services/metrics.js";

import type { TestDb } from "../fixtures/db.js";

// ---------------------------------------------------------------------------
// Test harness (mirrors `tunnel-proxy.test.ts`'s but trimmed to what we
// need: we don't exercise any HTTP routes here, only the tunnel manager's
// in-memory state machine).
// ---------------------------------------------------------------------------

async function buildForwardingTestApp(
  testDb: TestDb,
  opts: { a2aInFlightTtlMs?: number } = {},
) {
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

  const tunnelManager = new TunnelManager(app, {
    a2aInFlightTtlMs: opts.a2aInFlightTtlMs,
  });
  app.decorate("tunnelManager", tunnelManager);

  app.setErrorHandler((error, _request, reply) => {
    reply.status(error.statusCode ?? 500).send({
      error: error.message,
    });
  });

  process.env = originalEnv;

  return { app, tunnelManager };
}

// Helper: wait for the manager's async dispatch to flush
const flush = () => new Promise((r) => setTimeout(r, 30));

// Helper: parse a synthesized error response. The hub emits JSON
// `{ kind: "error", code, message }` on the response `payload`; the
// runtime emits an opaque success string. Tests assert on this shape
// when they expect a hub-synthesized error.
interface SynthesizedErrorPayload {
  kind: "error";
  code: string;
  message: string;
}

function parseSynthesizedError(p: string): SynthesizedErrorPayload {
  return JSON.parse(p) as SynthesizedErrorPayload;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Cross-runtime a2a forwarding (issue #16)", () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  });

  beforeEach(async () => {
    await resetTables(testDb.client);
    metrics.reset();
  });

  afterAll(async () => {
    await testDb.client.close();
  });

  it("forwards a signed PrincipalToPrincipalRequest from A to B verbatim, and correlates the response back", async () => {
    const { tunnelManager } = await buildForwardingTestApp(testDb);

    // Owner of A and B (separate user accounts so ACL is meaningful).
    const ownerA = await createUser(testDb.client, { namespace: "alice" });
    const ownerB = await createUser(testDb.client, { namespace: "bob" });

    // Two runtimes, two private agents. A's caller agent owns itself
    // (User A → Agent A); B's target agent is owned by User B. For
    // this case we give A's caller an allow-list entry on B's instance
    // so the hub-side ACL passes.
    const idA = makeRuntimeIdentity();
    const idB = makeRuntimeIdentity();
    await seedRuntime(testDb, idA.did, ownerA.id, "Runtime A");
    await seedRuntime(testDb, idB.did, ownerB.id, "Runtime B");

    const DID_A_AGENT = "did:peko:principal:helper-a";
    const DID_B_AGENT = "did:peko:principal:helper-b";

    await createInstance(testDb.client, {
      ownerId: ownerA.id,
      ownerSubject: { kind: "user", id: String(ownerA.id) },
      name: "caller-a",
      runtimeId: idA.did,
      exposure: "private",
      principalDid: DID_A_AGENT,
    });
    // Target is public — the hub-side ACL (`subjectCanAccess`) returns
    // false for Principal-kind caller → User owner (cross-kind denial), which
    // mirrors what `resolvePrincipalTarget` does in `instances.ts`. Public
    // exposure short-circuits the check. For a private target reached
    // via a Principal-kind caller, the runtime would never get a hit on the
    // directory API to begin with, so this case is the realistic path.
    await createInstance(testDb.client, {
      ownerId: ownerB.id,
      ownerSubject: { kind: "user", id: String(ownerB.id) },
      name: "target-b",
      runtimeId: idB.did,
      exposure: "public",
      principalDid: DID_B_AGENT,
    });

    const socketA = new MockWebSocket();
    const socketB = new MockWebSocket();
    tunnelManager.handleSocket(socketA.asWebSocket());
    tunnelManager.handleSocket(socketB.asWebSocket());

    await completeHandshake(socketA, idA.did, idA.privateKey, "nonce-a");
    await completeHandshake(socketB, idB.did, idB.privateKey, "nonce-b");

    expect(tunnelManager.isRuntimeConnected(idA.did)).toBe(true);
    expect(tunnelManager.isRuntimeConnected(idB.did)).toBe(true);

    // A sends a request to B.
    const SIGNATURE = "deadbeef-a2a-signature";
    const REQUEST_ID = "req-forward-success-1";
    socketA.triggerMessage({
      type: "principal_to_principal_request",
      requestId: REQUEST_ID,
      callerRuntimeId: idA.did,
      callerPrincipalDid: "caller-a",
      targetPrincipalDid: DID_B_AGENT,
      message: "hi from A",
      signature: SIGNATURE,
    });

    await flush();

    // B received the envelope verbatim — including `signature`.
    const receivedByB = socketB.sent.find(
      (m) => m.type === "principal_to_principal_request",
    );
    expect(receivedByB).toBeDefined();
    if (receivedByB?.type !== "principal_to_principal_request") throw new Error("unexpected");
    expect(receivedByB.requestId).toBe(REQUEST_ID);
    expect(receivedByB.callerRuntimeId).toBe(idA.did);
    expect(receivedByB.callerPrincipalDid).toBe("caller-a");
    expect(receivedByB.targetPrincipalDid).toBe(DID_B_AGENT);
    expect(receivedByB.message).toBe("hi from A");
    expect(receivedByB.signature).toBe(SIGNATURE); // untouched

    expect(metrics.snapshot()[CounterName.HubA2AForwarded]).toBe(1);
    expect(metrics.snapshot()[CounterName.HubA2AForbidden]).toBeUndefined();

    // B replies — the hub correlates back to A.
    socketB.triggerMessage({
      type: "principal_to_principal_response",
      requestId: REQUEST_ID,
      payload: "pong from B",
    });

    await flush();

    const receivedByA = socketA.sent.find(
      (m) => m.type === "principal_to_principal_response",
    );
    expect(receivedByA).toBeDefined();
    if (receivedByA?.type !== "principal_to_principal_response") throw new Error("unexpected");
    expect(receivedByA.requestId).toBe(REQUEST_ID);
    expect(receivedByA.payload).toBe("pong from B");
  });

  it("closes the caller's tunnel when callerRuntimeId doesn't match the authenticated runtime (impersonation)", async () => {
    const { tunnelManager } = await buildForwardingTestApp(testDb);

    const ownerA = await createUser(testDb.client, { namespace: "alice" });
    const ownerB = await createUser(testDb.client, { namespace: "bob" });

    const idA = makeRuntimeIdentity();
    const idB = makeRuntimeIdentity();
    await seedRuntime(testDb, idA.did, ownerA.id);
    await seedRuntime(testDb, idB.did, ownerB.id);

    const DID_B_AGENT = "did:peko:principal:helper-b";
    await createInstance(testDb.client, {
      ownerId: ownerB.id,
      ownerSubject: { kind: "user", id: String(ownerB.id) },
      name: "target-b",
      runtimeId: idB.did,
      exposure: "public", // ACL won't matter; we want to isolate the allowlist failure
      principalDid: DID_B_AGENT,
    });

    const socketA = new MockWebSocket();
    const socketB = new MockWebSocket();
    tunnelManager.handleSocket(socketA.asWebSocket());
    tunnelManager.handleSocket(socketB.asWebSocket());

    await completeHandshake(socketA, idA.did, idA.privateKey);
    await completeHandshake(socketB, idB.did, idB.privateKey);

    // A claims to be sending on behalf of B's runtime DID — the
    // hub should detect this and close A's tunnel.
    socketA.triggerMessage({
      type: "principal_to_principal_request",
      requestId: "req-impersonation",
      callerRuntimeId: idB.did, // claim ≠ authed runtime
      callerPrincipalDid: "caller-a",
      targetPrincipalDid: DID_B_AGENT,
      message: "hi",
      signature: "x",
    });

    await flush();

    // A's socket is closed (matches `closeConnection`'s existing
    // convention: 1000 + reason string).
    expect(socketA.closed).toBe(true);
    expect(socketA.closeCode).toBe(1000);
    expect(socketA.closeReason).toMatch(/source allowlist mismatch/);

    // B saw nothing.
    expect(
      socketB.sent.some((m) => m.type === "principal_to_principal_request"),
    ).toBe(false);

    // Counter incremented.
    expect(metrics.snapshot()[CounterName.HubA2ARejectedSourceAllowlist]).toBe(1);
    // Nothing forwarded.
    expect(metrics.snapshot()[CounterName.HubA2AForwarded]).toBeUndefined();
  });

  it("returns a structured 'target_not_found' response when the target agent DID is unknown", async () => {
    const { tunnelManager } = await buildForwardingTestApp(testDb);

    const ownerA = await createUser(testDb.client, { namespace: "alice" });
    const idA = makeRuntimeIdentity();
    await seedRuntime(testDb, idA.did, ownerA.id);

    const socketA = new MockWebSocket();
    tunnelManager.handleSocket(socketA.asWebSocket());
    await completeHandshake(socketA, idA.did, idA.privateKey);

    socketA.triggerMessage({
      type: "principal_to_principal_request",
      requestId: "req-target-missing",
      callerRuntimeId: idA.did,
      callerPrincipalDid: "caller-a",
      targetPrincipalDid: "did:peko:principal:not-on-file",
      message: "hi",
      signature: "x",
    });

    await flush();

    const resp = socketA.sent.find(
      (m) =>
        m.type === "principal_to_principal_response" &&
        m.requestId === "req-target-missing",
    );
    expect(resp).toBeDefined();
    if (resp?.type !== "principal_to_principal_response") throw new Error("unexpected");
    const err = parseSynthesizedError(resp.payload);
    expect(err.code).toBe("target_not_found");
    expect(err.message).toMatch(/did:peko:principal:not-on-file/);

    expect(metrics.snapshot()[CounterName.HubA2ATargetMissing]).toBe(1);
  });

  it("returns a structured 'target_offline' response when the target runtime has no connected tunnel", async () => {
    const { tunnelManager } = await buildForwardingTestApp(testDb);

    const ownerA = await createUser(testDb.client, { namespace: "alice" });
    const ownerB = await createUser(testDb.client, { namespace: "bob" });

    const idA = makeRuntimeIdentity();
    const idB = makeRuntimeIdentity();
    await seedRuntime(testDb, idA.did, ownerA.id);
    await seedRuntime(testDb, idB.did, ownerB.id);

    const DID_B_AGENT = "did:peko:principal:helper-b";
    await createInstance(testDb.client, {
      ownerId: ownerB.id,
      ownerSubject: { kind: "user", id: String(ownerB.id) },
      name: "target-b",
      runtimeId: idB.did,
      exposure: "public",
      principalDid: DID_B_AGENT,
    });

    // Only A is connected; B has no socket at all.
    const socketA = new MockWebSocket();
    tunnelManager.handleSocket(socketA.asWebSocket());
    await completeHandshake(socketA, idA.did, idA.privateKey);

    socketA.triggerMessage({
      type: "principal_to_principal_request",
      requestId: "req-target-offline",
      callerRuntimeId: idA.did,
      callerPrincipalDid: "caller-a",
      targetPrincipalDid: DID_B_AGENT,
      message: "hi",
      signature: "x",
    });

    await flush();

    const resp = socketA.sent.find(
      (m) =>
        m.type === "principal_to_principal_response" &&
        m.requestId === "req-target-offline",
    );
    expect(resp).toBeDefined();
    if (resp?.type !== "principal_to_principal_response") throw new Error("unexpected");
    const err = parseSynthesizedError(resp.payload);
    expect(err.code).toBe("target_offline");
    expect(err.message).toMatch(new RegExp(idB.did));

    expect(metrics.snapshot()[CounterName.HubA2ATargetOffline]).toBe(1);
  });

  it("returns a structured 'forbidden' response when the hub-side ACL denies", async () => {
    const { tunnelManager } = await buildForwardingTestApp(testDb);

    const ownerA = await createUser(testDb.client, { namespace: "alice" });
    const ownerB = await createUser(testDb.client, { namespace: "bob" });

    const idA = makeRuntimeIdentity();
    const idB = makeRuntimeIdentity();
    await seedRuntime(testDb, idA.did, ownerA.id);
    await seedRuntime(testDb, idB.did, ownerB.id);

    const DID_B_AGENT = "did:peko:principal:private-b";
    await createInstance(testDb.client, {
      ownerId: ownerB.id,
      ownerSubject: { kind: "user", id: String(ownerB.id) },
      name: "private-b",
      runtimeId: idB.did,
      exposure: "private", // private — A's agent is not in the allow-list
      principalDid: DID_B_AGENT,
      // No allowedPrincipals — A's caller agent is not on the list.
    });

    const socketA = new MockWebSocket();
    const socketB = new MockWebSocket();
    tunnelManager.handleSocket(socketA.asWebSocket());
    tunnelManager.handleSocket(socketB.asWebSocket());
    await completeHandshake(socketA, idA.did, idA.privateKey);
    await completeHandshake(socketB, idB.did, idB.privateKey);

    socketA.triggerMessage({
      type: "principal_to_principal_request",
      requestId: "req-forbidden",
      callerRuntimeId: idA.did,
      callerPrincipalDid: "caller-a",
      targetPrincipalDid: DID_B_AGENT,
      message: "hi",
      signature: "x",
    });

    await flush();

    const resp = socketA.sent.find(
      (m) =>
        m.type === "principal_to_principal_response" &&
        m.requestId === "req-forbidden",
    );
    expect(resp).toBeDefined();
    if (resp?.type !== "principal_to_principal_response") throw new Error("unexpected");
    const err = parseSynthesizedError(resp.payload);
    expect(err.code).toBe("forbidden");

    expect(metrics.snapshot()[CounterName.HubA2AForbidden]).toBe(1);
    // B never received anything.
    expect(
      socketB.sent.some((m) => m.type === "principal_to_principal_request"),
    ).toBe(false);
  });

  it("returns a structured 'timeout' response when the target never replies within TTL", async () => {
    // Inject a tiny TTL so the test runs in ~150ms instead of waiting
    // the production 30s. Real timers — fake timers conflict with the
    // `MockWebSocket` event-emitter flush helpers.
    const { tunnelManager } = await buildForwardingTestApp(testDb, {
      a2aInFlightTtlMs: 80,
    });

    const ownerA = await createUser(testDb.client, { namespace: "alice" });
    const ownerB = await createUser(testDb.client, { namespace: "bob" });

    const idA = makeRuntimeIdentity();
    const idB = makeRuntimeIdentity();
    await seedRuntime(testDb, idA.did, ownerA.id);
    await seedRuntime(testDb, idB.did, ownerB.id);

    const DID_B_AGENT = "did:peko:principal:target-b";
    await createInstance(testDb.client, {
      ownerId: ownerB.id,
      ownerSubject: { kind: "user", id: String(ownerB.id) },
      name: "target-b",
      runtimeId: idB.did,
      exposure: "public",
      principalDid: DID_B_AGENT,
    });

    const socketA = new MockWebSocket();
    const socketB = new MockWebSocket();
    tunnelManager.handleSocket(socketA.asWebSocket());
    tunnelManager.handleSocket(socketB.asWebSocket());
    await completeHandshake(socketA, idA.did, idA.privateKey);
    await completeHandshake(socketB, idB.did, idB.privateKey);

    socketA.triggerMessage({
      type: "principal_to_principal_request",
      requestId: "req-timeout",
      callerRuntimeId: idA.did,
      callerPrincipalDid: "caller-a",
      targetPrincipalDid: DID_B_AGENT,
      message: "hi",
      signature: "x",
    });

    // B got the request, but never replies.
    await flush();
    const reachedB = socketB.sent.some(
      (m) => m.type === "principal_to_principal_request",
    );
    expect(reachedB).toBe(true);

    // Wait past the injected 80ms TTL with slack.
    await new Promise((r) => setTimeout(r, 150));

    const resp = socketA.sent.find(
      (m) =>
        m.type === "principal_to_principal_response" &&
        m.requestId === "req-timeout",
    );
    expect(resp).toBeDefined();
    if (resp?.type !== "principal_to_principal_response") throw new Error("unexpected");
    const err = parseSynthesizedError(resp.payload);
    expect(err.code).toBe("timeout");

    expect(metrics.snapshot()[CounterName.HubA2ATimeout]).toBe(1);
  });

  it("synthesizes a response when the target runtime disconnects mid-flight", async () => {
    const { tunnelManager } = await buildForwardingTestApp(testDb);

    const ownerA = await createUser(testDb.client, { namespace: "alice" });
    const ownerB = await createUser(testDb.client, { namespace: "bob" });

    const idA = makeRuntimeIdentity();
    const idB = makeRuntimeIdentity();
    await seedRuntime(testDb, idA.did, ownerA.id);
    await seedRuntime(testDb, idB.did, ownerB.id);

    const DID_B_AGENT = "did:peko:principal:target-b";
    await createInstance(testDb.client, {
      ownerId: ownerB.id,
      ownerSubject: { kind: "user", id: String(ownerB.id) },
      name: "target-b",
      runtimeId: idB.did,
      exposure: "public",
      principalDid: DID_B_AGENT,
    });

    const socketA = new MockWebSocket();
    const socketB = new MockWebSocket();
    tunnelManager.handleSocket(socketA.asWebSocket());
    tunnelManager.handleSocket(socketB.asWebSocket());
    await completeHandshake(socketA, idA.did, idA.privateKey);
    await completeHandshake(socketB, idB.did, idB.privateKey);

    socketA.triggerMessage({
      type: "principal_to_principal_request",
      requestId: "req-peer-dies",
      callerRuntimeId: idA.did,
      callerPrincipalDid: "caller-a",
      targetPrincipalDid: DID_B_AGENT,
      message: "hi",
      signature: "x",
    });

    await flush();
    expect(
      socketB.sent.some((m) => m.type === "principal_to_principal_request"),
    ).toBe(true);

    // B dies.
    socketB.close(1006, "abnormal");
    await flush();

    const resp = socketA.sent.find(
      (m) =>
        m.type === "principal_to_principal_response" &&
        m.requestId === "req-peer-dies",
    );
    expect(resp).toBeDefined();
    if (resp?.type !== "principal_to_principal_response") throw new Error("unexpected");
    const err = parseSynthesizedError(resp.payload);
    // When the target disconnects, the survivor (caller) gets an
    // `internal_error` synthesized response — there's no specific
    // "target_offline" code path here, because the in-flight entry
    // is being cleaned up by `cleanupA2AForRuntime`.
    expect(err.code).toBe("internal_error");
  });

  it("notifies the target when the caller disconnects mid-flight (symmetric cleanup)", async () => {
    const { tunnelManager } = await buildForwardingTestApp(testDb);

    const ownerA = await createUser(testDb.client, { namespace: "alice" });
    const ownerB = await createUser(testDb.client, { namespace: "bob" });

    const idA = makeRuntimeIdentity();
    const idB = makeRuntimeIdentity();
    await seedRuntime(testDb, idA.did, ownerA.id);
    await seedRuntime(testDb, idB.did, ownerB.id);

    const DID_B_AGENT = "did:peko:principal:target-b";
    await createInstance(testDb.client, {
      ownerId: ownerB.id,
      ownerSubject: { kind: "user", id: String(ownerB.id) },
      name: "target-b",
      runtimeId: idB.did,
      exposure: "public",
      principalDid: DID_B_AGENT,
    });

    const socketA = new MockWebSocket();
    const socketB = new MockWebSocket();
    tunnelManager.handleSocket(socketA.asWebSocket());
    tunnelManager.handleSocket(socketB.asWebSocket());
    await completeHandshake(socketA, idA.did, idA.privateKey);
    await completeHandshake(socketB, idB.did, idB.privateKey);

    socketA.triggerMessage({
      type: "principal_to_principal_request",
      requestId: "req-caller-dies",
      callerRuntimeId: idA.did,
      callerPrincipalDid: "caller-a",
      targetPrincipalDid: DID_B_AGENT,
      message: "hi",
      signature: "x",
    });

    await flush();
    expect(
      socketB.sent.some((m) => m.type === "principal_to_principal_request"),
    ).toBe(true);

    // A dies. Without the symmetric cleanup, B would carry this
    // request until its own a2a timeout — and the eventual reply
    // would be silently dropped at `handlePrincipalToPrincipalResponse` (no
    // in-flight entry). With the fix, B gets an `internal_error`
    // synthesized response so it can release any local state.
    socketA.close(1006, "abnormal");
    await flush();

    const resp = socketB.sent.find(
      (m) =>
        m.type === "principal_to_principal_response" &&
        m.requestId === "req-caller-dies",
    );
    expect(resp).toBeDefined();
    if (resp?.type !== "principal_to_principal_response") throw new Error("unexpected");
    const err = parseSynthesizedError(resp.payload);
    expect(err.code).toBe("internal_error");
    expect(err.message).toMatch(/peer runtime disconnected/i);
  });
});
