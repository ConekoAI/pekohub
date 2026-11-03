import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createTestDb, resetTables } from "../fixtures/db.js";
import { buildTestApp } from "../fixtures/app.js";
import { createInstance, createUser, type TestUser } from "../fixtures/factories.js";
import { authHeaders } from "../fixtures/auth.js";
import type { TestDb } from "../fixtures/db.js";
import { pruneNotifications, NOTIFICATION_TTL_MS } from "../../src/services/notifications.js";

// ─────────────────────────────────────────────────────────────────────────────
// Notifications: what an account hears about without email — read by the
// website's bell and Peko desktop.
// ─────────────────────────────────────────────────────────────────────────────

describe("Notifications", () => {
  let testDb: TestDb;
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  let alice: TestUser;
  let bob: TestUser;

  beforeAll(async () => {
    testDb = await createTestDb();
    app = await buildTestApp({ testDb });
  });

  beforeEach(async () => {
    await resetTables(testDb.client);
    alice = await createUser(testDb.client, { namespace: "alice" });
    bob = await createUser(testDb.client, { namespace: "bob" });
  });

  afterAll(async () => {
    await app.close();
    await testDb.client.close();
  });

  async function inbox(user: TestUser) {
    const res = await app.inject({ method: "GET", url: "/v1/me/notifications", headers: await authHeaders(user) });
    expect(res.statusCode).toBe(200);
    return res.json() as {
      unread: number;
      notifications: { id: string; kind: string; text: string; path: string | null; url: string | null; readAt: string | null }[];
    };
  }

  const kinds = async (user: TestUser) => (await inbox(user)).notifications.map((n) => n.kind);

  it("needs a signed-in account", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/me/notifications" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/v1/me/notifications/read", payload: {} })).statusCode).toBe(401);
  });

  it("tells each side of a transfer what the other did", async () => {
    const peko = await createInstance(testDb.client, {
      ownerSubject: { kind: "user", id: String(alice.id) },
      name: "ada",
      exposure: "public",
    });
    const url = `/v1/principals/by-hub-id/${peko.hubId}/transfer`;
    const offer = async () =>
      app.inject({ method: "POST", url, headers: await authHeaders(alice), payload: { ownerHandle: "bob" } });

    await offer();
    const offered = (await inbox(bob)).notifications[0];
    expect(offered).toMatchObject({ kind: "transfer.offered", path: "/dashboard" });
    expect(offered.text).toContain("@alice offers you ada");
    expect(offered.url).toMatch(/\/dashboard$/);

    await app.inject({ method: "DELETE", url, headers: await authHeaders(bob) });
    expect(await kinds(alice)).toEqual(["transfer.declined"]);

    await offer();
    await app.inject({ method: "DELETE", url, headers: await authHeaders(alice) });
    expect((await kinds(bob)).slice(0, 2)).toEqual(["transfer.withdrawn", "transfer.offered"]);

    await offer();
    await app.inject({ method: "POST", url: `${url}/accept`, headers: await authHeaders(bob) });
    expect((await inbox(alice)).notifications[0]).toMatchObject({
      kind: "transfer.accepted",
      text: expect.stringContaining("@bob accepted ada"),
    });
  });

  it("reports a new API key, and marks notifications read one by one or all at once", async () => {
    const headers = await authHeaders(alice);
    await app.inject({ method: "POST", url: "/v1/auth/api-keys", headers, payload: { name: "ci" } });
    await app.inject({ method: "POST", url: "/v1/auth/api-keys", headers, payload: { name: "laptop" } });

    let box = await inbox(alice);
    expect(box.unread).toBe(2);
    expect(box.notifications[0]).toMatchObject({ kind: "security.api_key_created", path: "/profile" });
    expect(box.notifications[0].text).toContain('"laptop"');

    const read = await app.inject({
      method: "POST",
      url: "/v1/me/notifications/read",
      headers,
      payload: { ids: [box.notifications[0].id] },
    });
    expect(read.json()).toEqual({ marked: 1 });
    box = await inbox(alice);
    expect(box.unread).toBe(1);
    expect(box.notifications[0].readAt).not.toBeNull();

    // Another account's IDs mark nothing.
    const other = await app.inject({
      method: "POST",
      url: "/v1/me/notifications/read",
      headers: await authHeaders(bob),
      payload: { ids: [box.notifications[1].id] },
    });
    expect(other.json()).toEqual({ marked: 0 });

    await app.inject({ method: "POST", url: "/v1/me/notifications/read", headers, payload: {} });
    expect((await inbox(alice)).unread).toBe(0);
  });

  it("tells a publisher about a moderator's action and a reporter about the outcome", async () => {
    const mod = await createUser(testDb.client, { namespace: "mod", role: "moderator" });
    const published = await app.inject({
      method: "POST",
      url: "/v1/seeds",
      headers: await authHeaders(alice),
      payload: { seed: 'name = "ada"\n', version: "1.0.0" },
    });
    expect(published.statusCode).toBe(201);
    const filed = await app.inject({
      method: "POST",
      url: "/v1/reports",
      headers: await authHeaders(bob),
      payload: { target: "alice/ada", reason: "spam" },
    });
    expect(filed.statusCode).toBe(201);

    const hide = await app.inject({
      method: "POST",
      url: "/v1/admin/seeds/alice/ada/hide",
      headers: await authHeaders(mod),
      payload: { hidden: true, reason: "spam links", reportId: filed.json().id },
    });
    expect(hide.statusCode).toBe(200);

    expect((await inbox(alice)).notifications[0]).toMatchObject({
      kind: "moderation.seed_hidden",
      text: expect.stringContaining("hid your seed alice/ada: spam links"),
      path: "/dashboard/seeds",
    });
    expect((await inbox(bob)).notifications[0]).toMatchObject({
      kind: "moderation.report_resolved",
      text: expect.stringContaining("acted on your report about alice/ada"),
    });
  });

  it("keeps an account's notifications 90 days", async () => {
    await app.inject({ method: "POST", url: "/v1/auth/api-keys", headers: await authHeaders(alice), payload: { name: "k" } });
    expect(await pruneNotifications(Date.now())).toBe(0);
    expect(await pruneNotifications(Date.now() + NOTIFICATION_TTL_MS + 1000)).toBe(1);
    expect((await inbox(alice)).notifications).toHaveLength(0);
  });
});
