import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createTestDb, resetTables } from "../fixtures/db.js";
import { createUser } from "../fixtures/factories.js";
import {
  MockWebSocket,
  completeHandshake,
  seedRuntime,
  makeRuntimeIdentity,
} from "../fixtures/tunnel.js";
import { buildTunnelTestApp } from "../fixtures/tunnel-app.js";

import type { TestDb } from "../fixtures/db.js";
import type { WebSocket } from "ws";

// ─────────────────────────────────────────────────────────────────────────────
// Transport preference discovery via instance_announce (peko-runtime#34).
//
// Verifies that PekoHub ingests `transportPreference` and
// `runtimeDirectEndpoint` from the tunnel announce message, persists them
// in `instances.transport_preference` and `runtimes.direct_endpoint`, and
// returns them from the public directory API.
// ─────────────────────────────────────────────────────────────────────────────

describe("Transport announce ingestion", () => {
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

  it("persists transport fields and exposes them in the directory API", async () => {
    const { app, tunnelManager } = await buildTunnelTestApp(testDb);
    const user = await createUser(testDb.client, { namespace: "transport-alice" });
    const { did, privateKey } = makeRuntimeIdentity();
    const principalDid = "did:peko:principal:transport-direct-001";

    await seedRuntime(testDb, did, user.id);

    const socket = new MockWebSocket();
    tunnelManager.handleSocket(socket as unknown as WebSocket);
    await completeHandshake(socket, did, privateKey, "nonce-transport-1");

    socket.triggerMessage({
      type: "instance_announce",
      payload: {
        id: "a1b2c3d4-e5f6-47a8-b9c0-d1e2f3a4b5c6",
        type: "principal",
        name: "direct-agent",
        status: "online",
        exposure: "public",
        runtimeDisplayName: "Transport Test Runtime",
        capabilities: ["chat"],
        principalDid,
        transportPreference: "direct",
        runtimeDirectEndpoint: "wss://example.com:11436",
      },
    });

    await new Promise((r) => setTimeout(r, 200));

    // Directory API returns the fields for a public principal.
    const dirResp = await app.inject({
      method: "GET",
      url: `/v1/principals/by-did/${encodeURIComponent(principalDid)}`,
    });
    expect(dirResp.statusCode).toBe(200);
    const dirBody = JSON.parse(dirResp.payload);
    expect(dirBody.transportPreference).toBe("direct");
    expect(dirBody.directEndpoint).toBe("wss://example.com:11436");

    // The runtime-level direct endpoint is persisted on the runtimes row.
    const runtimeRows = await testDb.client.query(
      "SELECT direct_endpoint FROM runtimes WHERE runtime_did = $1",
      [did],
    );
    expect(runtimeRows.rows).toHaveLength(1);
    expect(runtimeRows.rows[0].direct_endpoint).toBe("wss://example.com:11436");

    // The principal-level transport preference is persisted on the instance row.
    const instanceRows = await testDb.client.query(
      "SELECT transport_preference FROM instances WHERE principal_did = $1",
      [principalDid],
    );
    expect(instanceRows.rows).toHaveLength(1);
    expect(instanceRows.rows[0].transport_preference).toBe("direct");
  });

  it("leaves previously stored transport values intact when a re-announce omits them", async () => {
    const { app, tunnelManager } = await buildTunnelTestApp(testDb);
    const user = await createUser(testDb.client, { namespace: "transport-bob" });
    const { did, privateKey } = makeRuntimeIdentity();
    const principalDid = "did:peko:principal:transport-sticky-002";
    const instanceId = "b2c3d4e5-f6a7-48b9-c0d1-e2f3a4b5c6d7";

    await seedRuntime(testDb, did, user.id);

    const socket = new MockWebSocket();
    tunnelManager.handleSocket(socket as unknown as WebSocket);
    await completeHandshake(socket, did, privateKey, "nonce-transport-2");

    // First announce: establish direct + endpoint.
    socket.triggerMessage({
      type: "instance_announce",
      payload: {
        id: instanceId,
        type: "principal",
        name: "sticky-agent",
        status: "online",
        exposure: "public",
        runtimeDisplayName: "Sticky Runtime",
        capabilities: ["chat"],
        principalDid,
        transportPreference: "direct",
        runtimeDirectEndpoint: "wss://sticky.example.com:11436",
      },
    });
    await new Promise((r) => setTimeout(r, 200));

    // Re-announce without transport fields.
    socket.triggerMessage({
      type: "instance_announce",
      payload: {
        id: instanceId,
        type: "principal",
        name: "sticky-agent",
        status: "online",
        exposure: "public",
        runtimeDisplayName: "Sticky Runtime",
        capabilities: ["chat"],
        principalDid,
      },
    });
    await new Promise((r) => setTimeout(r, 200));

    const dirResp = await app.inject({
      method: "GET",
      url: `/v1/principals/by-did/${encodeURIComponent(principalDid)}`,
    });
    expect(dirResp.statusCode).toBe(200);
    const dirBody = JSON.parse(dirResp.payload);
    expect(dirBody.transportPreference).toBe("direct");
    expect(dirBody.directEndpoint).toBe("wss://sticky.example.com:11436");
  });
});
