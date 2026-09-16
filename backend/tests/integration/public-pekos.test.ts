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
 * Machine/wire surfaces stay "principal": `/v1/principals/by-did`
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
        publicName: "Greeter",
        description: "Says hi",
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
          ownerName: "Alice",
          pekoName: "my-private-peko",
          publicName: "Mine",
          status: "online",
        },
      ],
    });
  });

  it("keeps /v1/principals/by-did byte-stable (machine wire surface)", async () => {
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
      url: `/v1/principals/by-did/${encodeURIComponent(did)}`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    // Exact key set + values — the runtime's resolver parses this
    // shape; the rename must not touch it.
    expect(JSON.parse(res.body)).toEqual({
      runtimeId: "did:key:zResolverRuntime",
      instanceId: instance.id,
      principalDid: did,
      ownerSubject: { kind: "user", id: String(user.id) },
      exposure: "public",
    });
  });
});
