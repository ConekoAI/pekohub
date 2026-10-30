/**
 * A peko's avatar travels on its runtime's announce: Hub keeps it on the
 * instance and serves it with the public profile, so remote clients show
 * the same face the owner picked.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createTestDb, resetTables } from "../fixtures/db.js";
import { buildTunnelTestApp } from "../fixtures/tunnel-app.js";
import { createUser } from "../fixtures/factories.js";
import {
  principalAnnouncement,
  MockWebSocket,
  completeHandshake,
  makeRuntimeIdentity,
  seedRuntime,
} from "../fixtures/tunnel.js";
import type { TestDb } from "../fixtures/db.js";
import type { WebSocket } from "ws";

describe("peko avatar on the Hub", () => {
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

  const settle = () => new Promise((r) => setTimeout(r, 50));

  it("keeps the announced avatar, serves it, and follows changes", async () => {
    const { app, tunnelManager } = await buildTunnelTestApp(testDb);
    const user = await createUser(testDb.client, { namespace: "carol" });
    const { did, privateKey } = makeRuntimeIdentity();
    await seedRuntime(testDb, did, user.id);
    const socket = new MockWebSocket();
    tunnelManager.handleSocket(socket as unknown as WebSocket);
    await completeHandshake(socket, did, privateKey, "nonce-avatar");

    const principal = makeRuntimeIdentity();
    const owner = { kind: "user", id: String(user.id) };
    const first = principalAnnouncement(did, principal, {
      owner,
      exposure: "public",
      avatar: "🦊",
    });
    const announce = async (overrides: Record<string, unknown>) => {
      const payload = { ...first, registrationId: undefined, ...overrides };
      if (!("avatar" in overrides)) delete (payload as Record<string, unknown>).avatar;
      socket.triggerMessage({ type: "instance_announce", payload });
      await settle();
    };
    const servedAvatar = async () => {
      const res = await app.inject({ method: "GET", url: "/v1/public/pekos/carol/helper" });
      expect(res.statusCode).toBe(200);
      return JSON.parse(res.body).liveInstance.avatar;
    };

    socket.triggerMessage({ type: "instance_announce", payload: first });
    await settle();
    expect(await servedAvatar()).toBe("🦊");

    // A runtime that predates the field sends none: the avatar stays.
    await announce({});
    expect(await servedAvatar()).toBe("🦊");

    await announce({ avatar: "RB" });
    expect(await servedAvatar()).toBe("RB");

    // An image URL is not an avatar; null clears it.
    await announce({ avatar: "https://example.com/me.png" });
    expect(await servedAvatar()).toBeNull();
    await announce({ avatar: "🐙" });
    await announce({ avatar: null });
    expect(await servedAvatar()).toBeNull();
  });
});
