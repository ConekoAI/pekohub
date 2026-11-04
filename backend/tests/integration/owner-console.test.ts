import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { createTestDb, resetTables } from "../fixtures/db.js";
import { buildTestApp } from "../fixtures/app.js";
import { createUser, createInstance } from "../fixtures/factories.js";
import { authHeaders } from "../fixtures/auth.js";
import { seedRuntime } from "../fixtures/tunnel.js";
import type { TestDb } from "../fixtures/db.js";

// What the owner console reads and changes: runtimes with their pekos,
// one publisher's seeds, the apps signed in to the account, and handing a
// peko to another account by handle.

const SEED = 'name = "ada"\n[identity]\ndisplay_name = "Ada"\n';

describe("Owner console API", () => {
  let testDb: TestDb;
  let app: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    testDb = await createTestDb();
    app = await buildTestApp({ testDb });
  });

  beforeEach(async () => {
    await resetTables(testDb.client);
  });

  afterAll(async () => {
    await app.close();
    await testDb.client.close();
  });

  it("lists your runtimes with whether they're connected and how many pekos they host", async () => {
    const alice = await createUser(testDb.client, { namespace: "alice" });
    await seedRuntime(testDb, "did:key:zRuntimeA", alice.id);
    await createInstance(testDb.client, {
      ownerSubject: { kind: "user", id: String(alice.id) },
      name: "ada",
      runtimeId: "did:key:zRuntimeA",
    });
    const res = await app.inject({ method: "GET", url: "/v1/runtimes", headers: await authHeaders(alice) });
    expect(res.statusCode).toBe(200);
    expect(res.json().runtimes).toEqual([
      expect.objectContaining({ runtimeDid: "did:key:zRuntimeA", connected: false, pekoCount: 1 }),
    ]);
  });

  it("unregistering a runtime takes its pekos and the groups it was home to off the Hub", async () => {
    const alice = await createUser(testDb.client, { namespace: "alice" });
    await seedRuntime(testDb, "did:key:zHome", alice.id);
    await seedRuntime(testDb, "did:key:zOther", alice.id);
    await createInstance(testDb.client, {
      ownerSubject: { kind: "user", id: String(alice.id) },
      name: "ada",
      runtimeId: "did:key:zHome",
    });
    for (const [id, home] of [["1001", "did:key:zHome"], ["1002", "did:key:zOther"]]) {
      await testDb.client.query(
        `INSERT INTO hub_groups (id, name, home_runtime, channel_id, owner_id, owner_address)
         VALUES ($1, 'g', $2, 'chan_x', $3, 'user:hub:x')`,
        [id, home, alice.id],
      );
      await testDb.client.query(`INSERT INTO hub_group_members (group_id, user_id) VALUES ($1, $2)`, [id, alice.id]);
    }

    const res = await app.inject({
      method: "DELETE",
      url: `/v1/runtimes/${encodeURIComponent("did:key:zHome")}`,
      headers: await authHeaders(alice),
    });
    expect(res.statusCode).toBe(204);
    const groups = await testDb.client.query("SELECT id::text FROM hub_groups ORDER BY id");
    expect(groups.rows).toEqual([{ id: "1002" }]);
    const members = await testDb.client.query("SELECT group_id::text FROM hub_group_members");
    expect(members.rows).toEqual([{ group_id: "1002" }]);
    expect((await testDb.client.query("SELECT 1 FROM instances")).rows).toHaveLength(0);
  });

  it("filters seeds to one publisher", async () => {
    const alice = await createUser(testDb.client, { namespace: "alice" });
    const bob = await createUser(testDb.client, { namespace: "bob" });
    for (const [user, version] of [[alice, "1.0.0"], [bob, "1.0.0"]] as const) {
      await app.inject({ method: "POST", url: "/v1/seeds", headers: await authHeaders(user), payload: { seed: SEED, version } });
    }
    const mine = (await app.inject({ method: "GET", url: "/v1/seeds?owner=alice" })).json();
    expect(mine.total).toBe(1);
    expect(mine.items[0].owner).toBe("alice");
    expect((await app.inject({ method: "GET", url: "/v1/seeds" })).json().total).toBe(2);
  });

  it("lists the apps signed in to your account and signs one out", async () => {
    const alice = await createUser(testDb.client, { namespace: "alice" });
    const headers = await authHeaders(alice);
    // Sign the desktop in once (code + PKCE).
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const start = await app.inject({
      method: "GET",
      url: `/oauth/authorize?response_type=code&client_id=peko-desktop&redirect_uri=${encodeURIComponent("http://localhost:19876/callback")}&code_challenge_method=S256&code_challenge=${challenge}`,
    });
    const requestToken = new URL(start.headers.location as string).searchParams.get("request")!;
    const decision = await app.inject({ method: "POST", url: "/v1/oauth/authorize/decision", headers, payload: { request: requestToken, approve: true } });
    const code = new URL(decision.json().redirectTo).searchParams.get("code")!;
    const tokens = (
      await app.inject({
        method: "POST",
        url: "/oauth/token",
        headers: { "user-agent": "Peko/0.1 (macOS)" },
        payload: { grant_type: "authorization_code", client_id: "peko-desktop", code, redirect_uri: "http://localhost:19876/callback", code_verifier: verifier },
      })
    ).json();

    const apps = (await app.inject({ method: "GET", url: "/v1/auth/apps", headers })).json().apps;
    expect(apps).toEqual([
      expect.objectContaining({ clientId: "peko-desktop", name: "Peko desktop", sessions: 1, devices: ["Peko/0.1 (macOS)"] }),
    ]);

    expect((await app.inject({ method: "DELETE", url: "/v1/auth/apps/peko-desktop", headers })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/v1/auth/apps", headers })).json().apps).toEqual([]);
    const refresh = await app.inject({
      method: "POST",
      url: "/oauth/token",
      payload: { grant_type: "refresh_token", client_id: "peko-desktop", refresh_token: tokens.refresh_token },
    });
    expect(refresh.json().error).toBe("invalid_grant");
    expect((await app.inject({ method: "DELETE", url: "/v1/auth/apps/evil", headers })).statusCode).toBe(404);
  });

  it("offers a peko to another account by handle; it moves when they accept", async () => {
    const alice = await createUser(testDb.client, { namespace: "alice" });
    const bob = await createUser(testDb.client, { namespace: "bob" });
    const instance = await createInstance(testDb.client, {
      ownerSubject: { kind: "user", id: String(alice.id) },
      name: "ada",
      exposure: "public",
    });
    const unknown = await app.inject({
      method: "POST",
      url: `/v1/principals/by-hub-id/${instance.hubId}/transfer`,
      headers: await authHeaders(alice),
      payload: { ownerHandle: "nobody" },
    });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json().error).toContain("@nobody");

    const res = await app.inject({
      method: "POST",
      url: `/v1/principals/by-hub-id/${instance.hubId}/transfer`,
      headers: await authHeaders(alice),
      payload: { ownerHandle: "@Bob" },
    });
    expect(res.statusCode, res.body).toBe(202);
    const owner = async () =>
      (await testDb.client.query(`SELECT owner_subject->>'id' AS id FROM instances WHERE id = $1`, [instance.id]))
        .rows[0].id;
    expect(await owner()).toBe(String(alice.id));

    const offers = await app.inject({ method: "GET", url: "/v1/me/transfers", headers: await authHeaders(bob) });
    expect(offers.json().transfers).toEqual([
      expect.objectContaining({ hubId: instance.hubId, direction: "incoming", pekoName: "ada", otherHandle: "alice" }),
    ]);
    const outgoing = await app.inject({ method: "GET", url: "/v1/me/transfers", headers: await authHeaders(alice) });
    expect(outgoing.json().transfers).toEqual([expect.objectContaining({ direction: "outgoing", otherHandle: "bob" })]);

    // Only the account it was offered to can take it.
    expect((await app.inject({
      method: "POST",
      url: `/v1/principals/by-hub-id/${instance.hubId}/transfer/accept`,
      headers: await authHeaders(alice),
    })).statusCode).toBe(404);
    const accepted = await app.inject({
      method: "POST",
      url: `/v1/principals/by-hub-id/${instance.hubId}/transfer/accept`,
      headers: await authHeaders(bob),
    });
    expect(accepted.statusCode, accepted.body).toBe(204);
    expect(await owner()).toBe(String(bob.id));
  });

  it("an offer can be declined or withdrawn, and lapses if the owner changes", async () => {
    const alice = await createUser(testDb.client, { namespace: "alice" });
    const bob = await createUser(testDb.client, { namespace: "bob" });
    const carol = await createUser(testDb.client, { namespace: "carol" });
    const instance = await createInstance(testDb.client, {
      ownerSubject: { kind: "user", id: String(alice.id) },
      name: "ada",
      exposure: "public",
    });
    const url = `/v1/principals/by-hub-id/${instance.hubId}/transfer`;
    const offer = async (from: typeof alice, to: string) =>
      app.inject({ method: "POST", url, headers: await authHeaders(from), payload: { ownerHandle: to } });
    const accept = async (user: typeof alice) =>
      app.inject({ method: "POST", url: `${url}/accept`, headers: await authHeaders(user) });

    expect((await offer(alice, "alice")).statusCode).toBe(422);

    await offer(alice, "bob");
    expect((await app.inject({ method: "DELETE", url, headers: await authHeaders(bob) })).statusCode).toBe(204);
    expect((await accept(bob)).statusCode).toBe(404);

    await offer(alice, "bob");
    expect((await app.inject({ method: "DELETE", url, headers: await authHeaders(alice) })).statusCode).toBe(204);
    expect((await accept(bob)).statusCode).toBe(404);

    // A newer offer replaces the open one.
    await offer(alice, "bob");
    await offer(alice, "carol");
    expect((await accept(bob)).statusCode).toBe(404);
    expect((await accept(carol)).statusCode).toBe(204);

    // Carol owns it; an offer Alice made before is gone with the transfer.
    expect((await offer(alice, "bob")).statusCode).toBe(403);
  });
});
