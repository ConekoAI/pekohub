import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createTestDb, resetTables } from "../fixtures/db.js";
import { buildTestApp } from "../fixtures/app.js";
import { createUser, createInstance } from "../fixtures/factories.js";
import { authHeaders } from "../fixtures/auth.js";
import type { TestDb } from "../fixtures/db.js";

/**
 * ADR-059 web-facing rename: principal → peko.
 *
 * Clean rename, NO aliases: the retired `/v1/public/principals/*` and
 * `/v1/me/accessible-principals` paths 404; the new
 * `/v1/public/pekos/*` and `/v1/me/accessible-pekos` paths serve the
 * same behavior (visitor cookie, liveInstance shape, ToS gate).
 *
 * Machine/wire surfaces stay "principal": `/v1/principals/by-hub-id`
 * must remain byte-stable (the runtime's cross-runtime
 * `principal_send` resolver consumes it).
 */

describe("ADR-059 public peko rename", () => {
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

  it("retired public paths 404 (clean rename, no aliases)", async () => {
    const app = await buildTestApp({ testDb });
    const user = await createUser(testDb.client, { namespace: "alice" });
    await createInstance(testDb.client, {
      ownerSubject: { kind: "user", id: String(user.id) },
      name: "some-peko",
      exposure: "public",
      status: "online",
    });

    for (const req of [
      { method: "GET", url: "/v1/public/principals/alice/some-peko" },
      { method: "POST", url: "/v1/public/principals/alice/some-peko/chat" },
      { method: "GET", url: "/v1/me/accessible-principals" },
    ] as const) {
      const res = await app.inject({
        method: req.method,
        url: req.url,
        ...(req.method === "POST" ? { payload: { message: "hi" } } : {}),
      });
      expect(res.statusCode, `${req.method} ${req.url}`).toBe(404);
    }
  });

  it("serves the public peko page with the unchanged liveInstance shape + visitor cookie", async () => {
    const app = await buildTestApp({ testDb });
    const user = await createUser(testDb.client, {
      namespace: "alice",
      displayName: "Alice",
      avatarUrl: "https://example.com/alice.png",
    });
    const instance = await createInstance(testDb.client, {
      ownerSubject: { kind: "user", id: String(user.id) },
      name: "greeter",
      exposure: "public",
      status: "online",
      publicName: "Greeter",
      description: "Says hi",
      capabilities: ["chat"],
      tosRequired: true,
      tosText: "Be nice.",
    });

    const res = await app.inject({
      method: "GET",
      url: "/v1/public/pekos/alice/greeter",
    });
    expect(res.statusCode).toBe(200);
    // Visitor cookie is minted on first page load (PR-B1 behavior
    // unchanged by the rename)
    expect(res.headers["set-cookie"]).toBeTruthy();

    const body = JSON.parse(res.body);
    expect(body).toEqual({
      liveInstance: {
        id: instance.id,
        hubId: instance.hubId,
        localId: instance.localId,
        publicName: "Greeter",
        description: "Says hi",
        avatar: null,
        owner: {
          id: user.id,
          name: "Alice",
          avatarUrl: "https://example.com/alice.png",
        },
        capabilities: ["chat"],
        status: "online",
        tosRequired: true,
        tosText: "Be nice.",
      },
    });
  });

  it("with visitor chat off (the default), anonymous chat asks to sign in and no visitor cookie is set", async () => {
    const app = await buildTestApp({ testDb, allowVisitorChat: false });
    const user = await createUser(testDb.client, { namespace: "alice" });
    await createInstance(testDb.client, {
      ownerSubject: { kind: "user", id: String(user.id) },
      name: "greeter",
      exposure: "public",
      status: "online",
    });

    const page = await app.inject({ method: "GET", url: "/v1/public/pekos/alice/greeter" });
    expect(page.statusCode).toBe(200);
    expect(page.headers["set-cookie"]).toBeUndefined();

    const chat = await app.inject({
      method: "POST",
      url: "/v1/public/pekos/alice/greeter/chat",
      payload: { message: "hi" },
    });
    expect(chat.statusCode).toBe(401);
    expect(JSON.parse(chat.body).code).toBe("sign_in_required");
  });

  it("renamed paths use peko-facing copy (Peko not found)", async () => {
    const app = await buildTestApp({ testDb });
    await createUser(testDb.client, { namespace: "alice" });

    const res = await app.inject({
      method: "GET",
      url: "/v1/public/pekos/alice/missing",
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe("Peko not found");
  });

  it("serves /v1/me/accessible-pekos with the renamed response shape", async () => {
    const app = await buildTestApp({ testDb });
    const user = await createUser(testDb.client, {
      namespace: "alice",
      displayName: "Alice",
    });
    const headers = await authHeaders(user);
    const instance = await createInstance(testDb.client, {
      ownerSubject: { kind: "user", id: String(user.id) },
      name: "my-private-peko",
      exposure: "private",
      status: "online",
      publicName: "Mine",
      runtimeDisplayName: "Alice's MacBook",
    });

    const res = await app.inject({
      method: "GET",
      url: "/v1/me/accessible-pekos",
      headers,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual({
      pekos: [
        {
          id: instance.id,
          hubId: instance.hubId,
          localId: instance.localId,
          owner: "alice",
          ownerName: "Alice",
          pekoName: "my-private-peko",
          publicName: "Mine",
          description: null,
          avatar: null,
          status: "online",
          exposure: "private",
          runtimeName: "Alice's MacBook",
        },
      ],
    });
  });

  it("returns both actor IDs and the signing credential separately", async () => {
    const app = await buildTestApp({ testDb });
    const user = await createUser(testDb.client, { namespace: "alice" });
    const headers = await authHeaders(user);
    const did = "did:peko:principal:bytestable";
    const instance = await createInstance(testDb.client, {
      ownerSubject: { kind: "user", id: String(user.id) },
      name: "resolver-target",
      runtimeId: "did:key:zResolverRuntime",
      exposure: "public",
      status: "online",
      principalDid: did,
    });

    const res = await app.inject({
      method: "GET",
      url: `/v1/principals/by-hub-id/${instance.hubId}`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    // Exact key set + values — the runtime's resolver parses this
    // shape; the rename must not touch it.
    expect(JSON.parse(res.body)).toEqual({
      runtimeId: "did:key:zResolverRuntime",
      instanceId: instance.id,
      principalDid: did,
      name: instance.name,
      hubId: instance.hubId,
      localId: instance.localId,
      identityKey: did,
      ownerSubject: { kind: "user", id: String(user.id) },
      ownerHandle: "alice",
      exposure: "public",
      // Additive: its face and liveness, for apps that list it.
      status: "online",
      avatar: null,
      description: null,
      // Additive: the website's share link (gap map C4).
      shareUrl: expect.stringMatching(/\/@alice\/resolver-target$/),
    });
  });

  // Runtime ADR-091 D6: a client without a runtime reads the signed-in
  // person's own conversation from the peko's host; the Hub stores nothing.
  describe("history for clients without a runtime", () => {
    async function setup() {
      const app = await buildTestApp({ testDb });
      const owner = await createUser(testDb.client, { namespace: "alice" });
      const reader = await createUser(testDb.client, { namespace: "bob" });
      const peko = await createInstance(testDb.client, {
        ownerSubject: { kind: "user", id: String(owner.id) },
        name: "greeter",
        exposure: "public",
        status: "online",
      });
      await createInstance(testDb.client, {
        ownerSubject: { kind: "user", id: String(owner.id) },
        name: "hidden",
        exposure: "private",
        status: "online",
      });
      return { app, reader, peko };
    }

    it("asks a visitor to sign in", async () => {
      const { app } = await setup();
      const res = await app.inject({ method: "GET", url: "/v1/public/pekos/alice/greeter/history" });
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe("sign_in_required");
    });

    it("says when the host is offline, and hides private pekos", async () => {
      const { app, reader } = await setup();
      const headers = await authHeaders(reader);
      const offline = await app.inject({ method: "GET", url: "/v1/public/pekos/alice/greeter/history", headers });
      expect(offline.statusCode).toBe(503);
      expect(offline.json().code).toBe("host_offline");
      const hidden = await app.inject({ method: "GET", url: "/v1/public/pekos/alice/hidden/history", headers });
      expect(hidden.statusCode).toBe(404);
      const bad = await app.inject({
        method: "GET",
        url: "/v1/public/pekos/alice/greeter/history?limit=500",
        headers,
      });
      expect(bad.statusCode).toBe(400);
    });

    it("relays the page the host serves, as the signed-in person", async () => {
      const { app, reader, peko } = await setup();
      const calls: unknown[][] = [];
      (app.tunnelManager as any).isRuntimeConnected = () => true;
      (app.tunnelRouter as any).proxyHistory = async (...args: unknown[]) => {
        calls.push(args);
        return { status: 200, body: { events: [{ kind: "posted", text: "hi" }], hasMore: false } };
      };
      const res = await app.inject({
        method: "GET",
        url: "/v1/public/pekos/alice/greeter/history?before=msg-9&limit=20",
        headers: await authHeaders(reader),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ events: [{ kind: "posted", text: "hi" }], hasMore: false });
      expect(calls).toHaveLength(1);
      const [runtimeId, instanceId, , query, caller] = calls[0];
      expect(runtimeId).toBe(peko.runtimeId);
      expect(instanceId).toBe(peko.id);
      expect(query).toEqual({ before: "msg-9", limit: 20 });
      expect(caller).toEqual({ kind: "user", id: String(reader.id) });
    });
  });
});
