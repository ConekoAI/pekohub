import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createTestDb, resetTables } from "../fixtures/db.js";
import { buildTunnelTestApp } from "../fixtures/tunnel-app.js";
import { buildTestApp } from "../fixtures/app.js";
import { createUser, createInstance } from "../fixtures/factories.js";
import { authHeaders } from "../fixtures/auth.js";
import {
  principalAnnouncement,
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

const SHARED_PRINCIPAL = makeRuntimeIdentity();
const SHARED_DID = SHARED_PRINCIPAL.did;

describe("ADR-056 D7: single public exposure per principal DID", () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  });

  beforeEach(async () => {
    await resetTables(testDb.client);
    sharedOwner = undefined;
  });

  afterAll(async () => {
    await testDb.client.close();
  });

  const runtimeIds = new WeakMap<MockWebSocket, string>();
  const runtimeOwners = new WeakMap<MockWebSocket, string>();
  // ADR-081 D4: every copy of the shared principal names its one owner —
  // the account of the runtime that first put it online.
  let sharedOwner: string | undefined;
  async function connectedRuntime(tag: string) {
    const { app, tunnelManager } = await buildTunnelTestApp(testDb);
    const user = await createUser(testDb.client, { namespace: `owner-${tag}` });
    const { did, privateKey } = makeRuntimeIdentity();
    await seedRuntime(testDb, did, user.id);
    const socket = new MockWebSocket();
    tunnelManager.handleSocket(socket as unknown as WebSocket);
    await completeHandshake(socket, did, privateKey, `nonce-${tag}`);
    runtimeIds.set(socket, did);
    runtimeOwners.set(socket, String(user.id));
    return { app, tunnelManager, user, did, socket };
  }

  function announce(
    socket: MockWebSocket,
    payload: Record<string, unknown>,
  ) {
    // The connected runtime is tracked explicitly by the fixture.
    sharedOwner ??= runtimeOwners.get(socket);
    const owner = { kind: "user", id: sharedOwner };
    socket.triggerMessage({ type: "instance_announce", payload: principalAnnouncement(runtimeIds.get(socket)!, SHARED_PRINCIPAL, { owner, ...payload }) });
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

  it("assigns a stable Hub actor ID, persists both IDs, and rejects rekeying", async () => {
    const runtime = await connectedRuntime("identity");
    const payload = principalAnnouncement(runtime.did, SHARED_PRINCIPAL, {name: "identity", exposure: "private", owner: {kind: "user", id: String(runtime.user.id)}});
    runtime.socket.triggerMessage({type: "instance_announce", payload}); await settle();
    const receipt = runtime.socket.sent.find(m => m.type === "principal_registered");
    expect(receipt?.type).toBe("principal_registered");
    if (receipt?.type !== "principal_registered") throw new Error("missing receipt");
    expect(receipt.localId).toBe(payload.localId); expect(receipt.registrationId).toBe(payload.registrationId);
    const row = await testDb.client.query("SELECT hub_id, local_id FROM instances WHERE id=$1",[payload.id]);
    expect(row.rows[0]).toEqual({hub_id: receipt.hubId, local_id: payload.localId});
    runtime.socket.triggerMessage({type: "instance_announce", payload: {...payload, registrationId: undefined}}); await settle();
    expect(runtime.socket.sent.filter(m => m.type === "principal_registered").map(m => m.type === "principal_registered" ? m.hubId : null)).toEqual([receipt.hubId,receipt.hubId]);
    runtime.socket.triggerMessage({type: "instance_announce", payload: {...payload, registrationId:"rekey", identityKey:"different-key"}}); await settle();
    expect(runtime.socket.sent.some(m => m.type === "principal_registration_rejected" && m.registrationId === "rekey")).toBe(true);
    await runtime.app.close();
  });

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
      exposure: "public",
      principalDid: SHARED_DID,
    });
    await settle();
    expect(await instanceRow(bUnlistedId)).toBeUndefined();

    // ADR-081 D7: a PRIVATE copy is refused too — a principal is online
    // on one runtime, and moving it needs its owner's approval.
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
    expect(await instanceRow(bPrivateId)).toBeUndefined();
    expect(
      b.socket.sent.some(
        (m) =>
          m.type === "principal_registration_rejected" &&
          m.message.includes("owner must approve the move"),
      ),
    ).toBe(true);
    expect((await instanceRow(rowA.rows[0].id))?.exposure).toBe("public");
  });

  it("moves the online link only with the owner's approval (ADR-081 D7)", async () => {
    const a = await connectedRuntime("move-a");
    // B connects to the same Hub (one tunnel manager), so Hub can tell A
    // its copy went offline.
    const bUser = await createUser(testDb.client, { namespace: "owner-move-b" });
    const bIdentity = makeRuntimeIdentity();
    await seedRuntime(testDb, bIdentity.did, bUser.id);
    const bSocket = new MockWebSocket();
    a.tunnelManager.handleSocket(bSocket as unknown as WebSocket);
    await completeHandshake(bSocket, bIdentity.did, bIdentity.privateKey, "nonce-move-b");
    runtimeIds.set(bSocket, bIdentity.did);
    runtimeOwners.set(bSocket, String(bUser.id));
    const b = { user: bUser, did: bIdentity.did, socket: bSocket };
    const aId = crypto.randomUUID();
    announce(a.socket, { id: aId, name: "mover", exposure: "private" });
    await settle();
    const receipt = a.socket.sent.find((m) => m.type === "principal_registered");
    if (receipt?.type !== "principal_registered") throw new Error("missing receipt");

    // Someone other than the owner cannot approve.
    const stranger = await authHeaders(b.user);
    const denied = await a.app.inject({
      method: "POST",
      url: `/v1/principals/by-hub-id/${receipt.hubId}/move`,
      headers: stranger,
      payload: { runtimeId: b.did },
    });
    expect(denied.statusCode).toBe(403);

    // The owner approves the move to B.
    const approved = await a.app.inject({
      method: "POST",
      url: `/v1/principals/by-hub-id/${receipt.hubId}/move`,
      headers: await authHeaders(a.user),
      payload: { runtimeId: b.did },
    });
    expect(approved.statusCode).toBe(204);

    const bId = crypto.randomUUID();
    announce(b.socket, { id: bId, name: "mover", exposure: "private" });
    await settle();
    expect((await instanceRow(bId))?.exposure).toBe("private");
    expect(await instanceRow(aId)).toBeUndefined();
    expect(a.socket.sent).toContainEqual(
      expect.objectContaining({ type: "principal_unlinked", hubId: receipt.hubId }),
    );
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

  it("keeps one instance row per principal, so a second public copy cannot arise (ADR-081 D7)", async () => {
    const app = await buildTestApp({ testDb });
    const user = await createUser(testDb.client, { namespace: "alice" });
    const headers = await authHeaders(user);

    const only = await createInstance(testDb.client, {
      ownerSubject: { kind: "user", id: String(user.id) },
      name: "already-public",
      status: "online",
      exposure: "public",
      principalDid: SHARED_DID,
    });
    // The database refuses a second row linked to the same Hub ID.
    await expect(
      createInstance(testDb.client, {
        ownerSubject: { kind: "user", id: String(user.id) },
        name: "wants-public",
        status: "online",
        exposure: "private",
        principalDid: SHARED_DID,
      }),
    ).rejects.toThrow();

    // The one instance changes exposure freely.
    for (const exposure of ["private", "public", "local_only"]) {
      const res = await app.inject({
        method: "PATCH",
        url: `/v1/instances/${only.id}/exposure`,
        headers,
        payload: { exposure },
      });
      expect(res.statusCode).toBe(200);
    }
  });

  it("requires verified registration before exposing a local-only principal", async () => {
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
      exposure: "local_only",
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/v1/instances/${other.id}/exposure`,
      headers,
      payload: { exposure: "public" },
    });
    expect(res.statusCode).toBe(400);
  });
});
