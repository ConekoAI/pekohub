import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createTestDb, resetTables } from "../fixtures/db.js";
import { buildTunnelTestApp } from "../fixtures/tunnel-app.js";
import { buildTestApp } from "../fixtures/app.js";
import { createUser, createInstance } from "../fixtures/factories.js";
import { authHeaders } from "../fixtures/auth.js";
import {
  MockWebSocket,
  completeHandshake,
  makeRuntimeIdentity,
  seedRuntime,
} from "../fixtures/tunnel.js";
import type { TestDb } from "../fixtures/db.js";
import type { WebSocket } from "ws";

/**
 * ADR-056 D7: at most ONE publicly exposed (`public`/`unlisted`)
 * instance per principal DID network-wide. Enforced on both mutation
 * paths:
 *
 *   1. `instance_announce` (tunnel) — a runtime announcing a
 *      public/unlisted instance for a DID another instance already
 *      serves publicly is rejected (announce dropped, no row write).
 *   2. `PATCH /v1/instances/:id/exposure` (HTTP) — 409 Conflict
 *      naming the conflicting instance.
 *
 * Legacy (non-did:key) DIDs skip the PoP step, which keeps these
 * tests focused on the exposure rule; PoP is covered by the
 * ADR-058 D4 suite in tests/unit/tunnel-manager.test.ts.
 */

const SHARED_DID = "did:peko:principal:d7shared";

describe("ADR-056 D7: single public exposure per principal DID", () => {
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

  async function connectedRuntime(tag: string) {
    const { app, tunnelManager } = await buildTunnelTestApp(testDb);
    const user = await createUser(testDb.client, { namespace: `owner-${tag}` });
    const { did, privateKey } = makeRuntimeIdentity();
    await seedRuntime(testDb, did, user.id);
    const socket = new MockWebSocket();
    tunnelManager.handleSocket(socket as unknown as WebSocket);
    await completeHandshake(socket, did, privateKey, `nonce-${tag}`);
    return { app, tunnelManager, user, did, socket };
  }

  function announce(
    socket: MockWebSocket,
    payload: Record<string, unknown>,
  ) {
    socket.triggerMessage({ type: "instance_announce", payload });
  }

  async function settle() {
    await new Promise((r) => setTimeout(r, 50));
  }

  async function instanceRow(id: string) {
    const res = await testDb.client.query(
      `SELECT id, exposure FROM instances WHERE id = $1`,
      [id],
    );
    return res.rows[0];
  }

  it("rejects an announce that would publicly expose an already-public DID", async () => {
    const a = await connectedRuntime("a");
    const b = await connectedRuntime("b");

    // Runtime A announces its principal publicly
    announce(a.socket, {
      id: crypto.randomUUID(),
      type: "principal",
      name: "public-peko",
      status: "online",
      exposure: "public",
      principalDid: SHARED_DID,
    });
    await settle();
    const rowA = await testDb.client.query(
      `SELECT id, exposure FROM instances WHERE principal_did = $1`,
      [SHARED_DID],
    );
    expect(rowA.rows).toHaveLength(1);
    expect(rowA.rows[0].exposure).toBe("public");

    // Runtime B (a transported copy) announces the same DID publicly
    // — D7 rejects the announce outright (no row, no upsert)
    const bInstanceId = crypto.randomUUID();
    announce(b.socket, {
      id: bInstanceId,
      type: "principal",
      name: "transported-copy",
      status: "online",
      exposure: "public",
      principalDid: SHARED_DID,
    });
    await settle();
    expect(await instanceRow(bInstanceId)).toBeUndefined();

    // Same DID at `unlisted` is also publicly reachable → rejected
    const bUnlistedId = crypto.randomUUID();
    announce(b.socket, {
      id: bUnlistedId,
      type: "principal",
      name: "transported-copy",
      status: "online",
      exposure: "unlisted",
      principalDid: SHARED_DID,
    });
    await settle();
    expect(await instanceRow(bUnlistedId)).toBeUndefined();

    // ... but a PRIVATE announce for the same DID is fine (transport
    // window: the copy exists, it just can't serve the world)
    const bPrivateId = crypto.randomUUID();
    announce(b.socket, {
      id: bPrivateId,
      type: "principal",
      name: "transported-copy",
      status: "online",
      exposure: "private",
      principalDid: SHARED_DID,
    });
    await settle();
    expect((await instanceRow(bPrivateId))?.exposure).toBe("private");
  });

  it("lets the currently-public instance re-announce (idempotent, not a conflict)", async () => {
    const a = await connectedRuntime("a");
    const instanceId = crypto.randomUUID();

    announce(a.socket, {
      id: instanceId,
      type: "principal",
      name: "public-peko",
      status: "online",
      exposure: "public",
      principalDid: SHARED_DID,
    });
    await settle();
    expect((await instanceRow(instanceId))?.exposure).toBe("public");

    // Re-announce (e.g. tunnel reconnect) — the D7 check excludes the
    // announcing instance itself
    announce(a.socket, {
      id: instanceId,
      type: "principal",
      name: "public-peko",
      status: "online",
      exposure: "public",
      principalDid: SHARED_DID,
    });
    await settle();
    expect((await instanceRow(instanceId))?.exposure).toBe("public");
  });

  it("returns 409 from PATCH /instances/:id/exposure when another instance is public for the DID", async () => {
    const app = await buildTestApp({ testDb });
    const user = await createUser(testDb.client, { namespace: "alice" });
    const headers = await authHeaders(user);

    const publicOne = await createInstance(testDb.client, {
      ownerSubject: { kind: "user", id: String(user.id) },
      name: "already-public",
      status: "online",
      exposure: "public",
      principalDid: SHARED_DID,
    });
    const candidate = await createInstance(testDb.client, {
      ownerSubject: { kind: "user", id: String(user.id) },
      name: "wants-public",
      status: "online",
      exposure: "unexposed",
      principalDid: SHARED_DID,
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/v1/instances/${candidate.id}/exposure`,
      headers,
      payload: { exposure: "public" },
    });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error).toContain("already-public");
    expect(body.error).toContain(publicOne.id);
    expect(body.conflictingInstanceId).toBe(publicOne.id);

    // unlisted is publicly reachable too → also 409
    const resUnlisted = await app.inject({
      method: "PATCH",
      url: `/v1/instances/${candidate.id}/exposure`,
      headers,
      payload: { exposure: "unlisted" },
    });
    expect(resUnlisted.statusCode).toBe(409);

    // private is not publicly reachable → allowed
    const resPrivate = await app.inject({
      method: "PATCH",
      url: `/v1/instances/${candidate.id}/exposure`,
      headers,
      payload: { exposure: "private" },
    });
    expect(resPrivate.statusCode).toBe(200);

    // Retiring the public instance frees the DID
    const retire = await app.inject({
      method: "PATCH",
      url: `/v1/instances/${publicOne.id}/exposure`,
      headers,
      payload: { exposure: "unexposed" },
    });
    expect(retire.statusCode).toBe(200);

    const retry = await app.inject({
      method: "PATCH",
      url: `/v1/instances/${candidate.id}/exposure`,
      headers,
      payload: { exposure: "public" },
    });
    expect(retry.statusCode).toBe(200);
  });

  it("does not constrain instances without a principal DID", async () => {
    const app = await buildTestApp({ testDb });
    const user = await createUser(testDb.client, { namespace: "alice" });
    const headers = await authHeaders(user);

    await createInstance(testDb.client, {
      ownerSubject: { kind: "user", id: String(user.id) },
      name: "did-less-public",
      status: "online",
      exposure: "public",
    });
    const other = await createInstance(testDb.client, {
      ownerSubject: { kind: "user", id: String(user.id) },
      name: "did-less-candidate",
      status: "online",
      exposure: "unexposed",
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/v1/instances/${other.id}/exposure`,
      headers,
      payload: { exposure: "public" },
    });
    expect(res.statusCode).toBe(200);
  });
});
