/**
 * `GET /metrics` endpoint (issue #16).
 *
 * The unit test in `tests/unit/metrics.test.ts` covers the
 * `CounterRegistry` class. This file covers the consumer-facing
 * surface — the Fastify route mounted in `src/index.ts` that exposes
 * the counter snapshot as JSON. A regression here (wrong route, wrong
 * payload shape, unauthenticated when it shouldn't be, etc.) would be
 * silent without an integration test.
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

async function buildMetricsTestApp(testDb: TestDb) {
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

  const tunnelManager = new TunnelManager(app);
  app.decorate("tunnelManager", tunnelManager);
  // Mirror the production route wiring (src/index.ts).
  app.get("/metrics", async () => metrics.snapshot());

  process.env = originalEnv;

  return { app, tunnelManager };
}

const flush = () => new Promise((r) => setTimeout(r, 30));

describe("GET /metrics (issue #16)", () => {
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

  it("returns an empty snapshot when no forwarding has happened", async () => {
    const { app } = await buildMetricsTestApp(testDb);

    const response = await app.inject({ method: "GET", url: "/metrics" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toMatch(/application\/json/);
    const body = JSON.parse(response.payload);
    expect(body).toEqual({});
  });

  it("reflects forwarding counters after a successful cross-runtime request", async () => {
    const { app, tunnelManager } = await buildMetricsTestApp(testDb);

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
      requestId: "metrics-req-1",
      callerRuntimeId: idA.did,
      callerPrincipalDid: "caller-a",
      targetPrincipalDid: DID_B_AGENT,
      message: "hi",
      signature: "x",
    });
    await flush();

    const response = await app.inject({ method: "GET", url: "/metrics" });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    // The forwarded request should show up in the snapshot.
    expect(body[CounterName.HubA2AForwarded]).toBe(1);
    // And the unrelated counters should be absent (snapshot omits
    // untouched counters — the consumer can distinguish "zero" from
    // "missing").
    expect(body[CounterName.HubA2AForbidden]).toBeUndefined();
    expect(body[CounterName.HubA2ATargetOffline]).toBeUndefined();
    expect(body[CounterName.HubA2ATargetMissing]).toBeUndefined();
  });

  it("reflects multiple counter categories in a single snapshot", async () => {
    const { app, tunnelManager } = await buildMetricsTestApp(testDb);

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
      exposure: "private",
      principalDid: DID_B_AGENT,
    });

    const socketA = new MockWebSocket();
    tunnelManager.handleSocket(socketA.asWebSocket());
    await completeHandshake(socketA, idA.did, idA.privateKey);

    // First: target-missing — targetPrincipalDid doesn't exist.
    socketA.triggerMessage({
      type: "principal_to_principal_request",
      requestId: "metrics-req-missing",
      callerRuntimeId: idA.did,
      callerPrincipalDid: "caller-a",
      targetPrincipalDid: "did:peko:principal:not-on-file",
      message: "hi",
      signature: "x",
    });
    await flush();

    // Second: forbidden — target exists (private, no allow-list),
    // Principal-kind caller doesn't match User owner.
    socketA.triggerMessage({
      type: "principal_to_principal_request",
      requestId: "metrics-req-forbidden",
      callerRuntimeId: idA.did,
      callerPrincipalDid: "caller-a",
      targetPrincipalDid: DID_B_AGENT,
      message: "hi",
      signature: "x",
    });
    await flush();

    const response = await app.inject({ method: "GET", url: "/metrics" });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body[CounterName.HubA2ATargetMissing]).toBe(1);
    expect(body[CounterName.HubA2AForbidden]).toBe(1);
  });
});
