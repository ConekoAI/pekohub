/**
 * ADR-081 D4: the Hub's record is an online principal's owner.
 *
 * - An announce never changes the owner; a runtime announcing a different
 *   one is refused and told the recorded owner.
 * - Registering a principal under another account's ownership needs that
 *   account's consent.
 * - Only the recorded owner transfers it — through the API, or over the
 *   tunnel when the linked runtime's account is the owner — and the linked
 *   runtime is told.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createTestDb, resetTables } from "../fixtures/db.js";
import { buildTunnelTestApp } from "../fixtures/tunnel-app.js";
import { createUser } from "../fixtures/factories.js";
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

describe("ADR-081 D4: the Hub records an online principal's owner", () => {
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
    return { app, user, did, socket };
  }

  const settle = () => new Promise((r) => setTimeout(r, 50));

  async function recordedOwner(hubId: string) {
    const res = await testDb.client.query(
      `SELECT owner_subject->>'id' AS owner FROM instances WHERE hub_id = $1`,
      [hubId],
    );
    return res.rows[0]?.owner as string | undefined;
  }

  /** Register a principal owned by the runtime's own account. */
  async function online(runtime: Awaited<ReturnType<typeof connectedRuntime>>) {
    const principal = makeRuntimeIdentity();
    const owner = { kind: "user", id: String(runtime.user.id) };
    const payload = principalAnnouncement(runtime.did, principal, { owner });
    runtime.socket.triggerMessage({ type: "instance_announce", payload });
    await settle();
    const receipt = runtime.socket.sent.find((m) => m.type === "principal_registered");
    if (receipt?.type !== "principal_registered") throw new Error("missing receipt");
    return { principal, payload, hubId: receipt.hubId };
  }

  it("refuses an announce that names another owner and tells the runtime the recorded one", async () => {
    const runtime = await connectedRuntime("edit");
    const { principal, payload, hubId } = await online(runtime);
    const mallory = await createUser(testDb.client, { namespace: "mallory" });

    runtime.socket.triggerMessage({
      type: "instance_announce",
      payload: principalAnnouncement(runtime.did, principal, {
        ...payload,
        registrationId: "edited-owner",
        owner: { kind: "user", id: String(mallory.id) },
      }),
    });
    await settle();

    expect(
      runtime.socket.sent.some(
        (m) => m.type === "principal_registration_rejected" && m.registrationId === "edited-owner",
      ),
    ).toBe(true);
    expect(runtime.socket.sent).toContainEqual(
      expect.objectContaining({
        type: "principal_owner_changed",
        localId: payload.localId,
        hubId,
        ownerId: String(runtime.user.id),
      }),
    );
    expect(await recordedOwner(hubId)).toBe(String(runtime.user.id));
  });

  it("needs the owner's consent to register a principal under their account", async () => {
    const runtime = await connectedRuntime("host");
    const bob = await createUser(testDb.client, { namespace: "bob" });
    const principal = makeRuntimeIdentity();
    const owner = { kind: "user", id: String(bob.id) };

    const first = principalAnnouncement(runtime.did, principal, { owner, registrationId: "unconsented" });
    runtime.socket.triggerMessage({ type: "instance_announce", payload: first });
    await settle();
    const rejected = runtime.socket.sent.find(
      (m) => m.type === "principal_registration_rejected" && m.registrationId === "unconsented",
    );
    if (rejected?.type !== "principal_registration_rejected") throw new Error("expected a rejection");
    expect(rejected.message).toContain("owner must approve");
    const hubId = /by-hub-id\/([0-9a-f-]{36})\//.exec(rejected.message)?.[1];
    expect(hubId).toBeDefined();

    const consent = await runtime.app.inject({
      method: "POST",
      url: `/v1/principals/by-hub-id/${hubId}/move`,
      headers: await authHeaders(bob),
      payload: { runtimeId: runtime.did },
    });
    expect(consent.statusCode).toBe(204);

    runtime.socket.triggerMessage({
      type: "instance_announce",
      payload: principalAnnouncement(runtime.did, principal, { ...first, registrationId: "consented" }),
    });
    await settle();
    expect(runtime.socket.sent).toContainEqual(
      expect.objectContaining({ type: "principal_registered", registrationId: "consented", hubId }),
    );
    expect(await recordedOwner(hubId!)).toBe(String(bob.id));
  });

  it("lets only the recorded owner transfer through the API, and tells the runtime", async () => {
    const runtime = await connectedRuntime("api");
    const { payload, hubId } = await online(runtime);
    const carol = await createUser(testDb.client, { namespace: "carol" });
    const url = `/v1/principals/by-hub-id/${hubId}/transfer`;

    const stranger = await runtime.app.inject({
      method: "POST",
      url,
      headers: await authHeaders(carol),
      payload: { ownerId: String(carol.id) },
    });
    expect(stranger.statusCode).toBe(403);
    const nobody = await runtime.app.inject({
      method: "POST",
      url,
      headers: await authHeaders(runtime.user),
      payload: { ownerId: crypto.randomUUID() },
    });
    expect(nobody.statusCode).toBe(422);

    const moved = await runtime.app.inject({
      method: "POST",
      url,
      headers: await authHeaders(runtime.user),
      payload: { ownerId: String(carol.id) },
    });
    expect(moved.statusCode).toBe(204);
    expect(await recordedOwner(hubId)).toBe(String(carol.id));
    expect(runtime.socket.sent).toContainEqual(
      expect.objectContaining({
        type: "principal_owner_changed",
        localId: payload.localId,
        hubId,
        ownerId: String(carol.id),
      }),
    );
  });

  it("transfers over the tunnel only when the runtime's account is the owner", async () => {
    const runtime = await connectedRuntime("tunnel");
    const { payload, hubId } = await online(runtime);
    const dave = await createUser(testDb.client, { namespace: "dave" });
    const transfer = (requestId: string, ownerId: string) =>
      runtime.socket.triggerMessage({
        type: "principal_transfer",
        requestId,
        localId: payload.localId,
        hubId,
        ownerId,
      });

    transfer("to-dave", String(dave.id));
    await settle();
    expect(runtime.socket.sent).toContainEqual(
      expect.objectContaining({
        type: "principal_owner_changed",
        requestId: "to-dave",
        hubId,
        ownerId: String(dave.id),
      }),
    );
    expect(await recordedOwner(hubId)).toBe(String(dave.id));

    // Dave owns it now; the runtime's account can no longer transfer it.
    transfer("take-back", String(runtime.user.id));
    await settle();
    expect(runtime.socket.sent).toContainEqual(
      expect.objectContaining({ type: "principal_transfer_rejected", requestId: "take-back" }),
    );
    expect(await recordedOwner(hubId)).toBe(String(dave.id));
  });
});
