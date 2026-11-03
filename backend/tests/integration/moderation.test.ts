import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import { createTestDb, resetTables } from "../fixtures/db.js";
import { buildTestApp } from "../fixtures/app.js";
import { createInstance, createRuntime, createUser, type TestUser } from "../fixtures/factories.js";
import { authHeaders } from "../fixtures/auth.js";
import type { TestDb } from "../fixtures/db.js";

// Trust & safety and admin (gap map B2/B3): roles, reports, and the
// moderator actions that answer them.

const SEED = `name = "ada"

[identity]
display_name = "Ada"
`;

describe("Moderation", () => {
  let testDb: TestDb;
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  let alice: TestUser;
  let mod: TestUser;
  let admin: TestUser;

  beforeAll(async () => {
    testDb = await createTestDb();
    app = await buildTestApp({ testDb });
  });

  beforeEach(async () => {
    await resetTables(testDb.client);
    alice = await createUser(testDb.client, { namespace: "alice" });
    mod = await createUser(testDb.client, { namespace: "mod", role: "moderator" });
    admin = await createUser(testDb.client, { namespace: "boss", role: "admin" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await app.close();
    await testDb.client.close();
  });

  async function as(user: TestUser) {
    return authHeaders(user);
  }

  async function publish(user: TestUser, version: string) {
    const res = await app.inject({
      method: "POST",
      url: "/v1/seeds",
      headers: await as(user),
      payload: { seed: SEED, version },
    });
    expect(res.statusCode).toBe(201);
  }

  async function report(user: TestUser, target: string, reason = "spam", note?: string) {
    return app.inject({
      method: "POST",
      url: "/v1/reports",
      headers: await as(user),
      payload: { target, reason, ...(note ? { note } : {}) },
    });
  }

  async function moderationLog() {
    const res = await testDb.client.query<{ action: string; resource: string; user_id: string }>(
      "SELECT action, resource, user_id FROM audit_logs WHERE namespace = 'moderation' ORDER BY id",
    );
    return res.rows;
  }

  async function publicPeko(owner: TestUser, name = "ada") {
    return createInstance(testDb.client, {
      name,
      ownerSubject: { kind: "user", id: owner.id },
      exposure: "public",
      status: "online",
      runtimeId: `did:key:runtime-${owner.namespace}`,
    });
  }

  describe("roles", () => {
    it("tells the signed-in user their role", async () => {
      const me = await app.inject({ method: "GET", url: "/v1/auth/me", headers: await as(mod) });
      expect(me.json()).toMatchObject({ namespace: "mod", role: "moderator" });
    });

    it("keeps the report queue to moderators", async () => {
      expect((await app.inject({ method: "GET", url: "/v1/admin/reports" })).statusCode).toBe(401);
      const res = await app.inject({ method: "GET", url: "/v1/admin/reports", headers: await as(alice) });
      expect(res.statusCode).toBe(403);
      const ok = await app.inject({ method: "GET", url: "/v1/admin/reports", headers: await as(mod) });
      expect(ok.statusCode).toBe(200);
    });

    it("reads another namespace's audit log only as an admin, whatever the environment", async () => {
      const url = "/v1/admin/audit?namespace=bob";
      expect((await app.inject({ method: "GET", url, headers: await as(alice) })).statusCode).toBe(403);
      expect((await app.inject({ method: "GET", url, headers: await as(mod) })).statusCode).toBe(403);
      expect((await app.inject({ method: "GET", url, headers: await as(admin) })).statusCode).toBe(200);
      const own = await app.inject({ method: "GET", url: "/v1/admin/audit?namespace=alice", headers: await as(alice) });
      expect(own.statusCode).toBe(200);
      const moderation = await app.inject({
        method: "GET",
        url: "/v1/admin/audit?namespace=moderation",
        headers: await as(mod),
      });
      expect(moderation.statusCode).toBe(200);
    });

    it("lets only an admin grant roles, and never their own", async () => {
      const grant = (by: TestUser, handle: string, role: string) =>
        as(by).then((headers) =>
          app.inject({ method: "PUT", url: `/v1/admin/users/${handle}/role`, headers, payload: { role } }),
        );
      expect((await grant(mod, "alice", "moderator")).statusCode).toBe(403);
      expect((await grant(admin, "boss", "user")).statusCode).toBe(403);
      const res = await grant(admin, "@alice", "moderator");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ handle: "alice", role: "moderator" });
      const me = await app.inject({ method: "GET", url: "/v1/auth/me", headers: await as(alice) });
      expect(me.json().role).toBe("moderator");
      expect(await moderationLog()).toEqual([
        expect.objectContaining({ action: "account.role", resource: "@alice", user_id: admin.id }),
      ]);
    });
  });

  describe("reports", () => {
    it("needs a sign-in, a known target and a reason", async () => {
      await publish(alice, "1.0.0");
      const anonymous = await app.inject({
        method: "POST",
        url: "/v1/reports",
        payload: { target: "alice/ada", reason: "spam" },
      });
      expect(anonymous.statusCode).toBe(401);
      expect((await report(mod, "alice/ada", "rude")).statusCode).toBe(400);
      expect((await report(mod, "not a target")).statusCode).toBe(400);
      expect((await report(mod, "alice/nope")).statusCode).toBe(404);
      expect((await report(mod, "alice/ada@9.9.9")).statusCode).toBe(404);
      expect((await report(mod, "@nobody")).statusCode).toBe(404);
      expect((await report(mod, "@alice/ghost")).statusCode).toBe(404);
    });

    it("files reports on a seed version, a peko, a person, and a group", async () => {
      await publish(alice, "1.0.0");
      const peko = await publicPeko(alice);

      const seed = await report(mod, "alice/ada@1.0.0", "malicious", "Tells people to run a shell script");
      expect(seed.statusCode).toBe(201);
      expect(seed.json()).toMatchObject({ targetKind: "seed", target: "alice/ada@1.0.0", status: "open" });
      expect((await report(mod, "@alice/ada", "impersonation")).json()).toMatchObject({
        targetKind: "peko",
        target: "@alice/ada",
      });
      expect((await report(mod, "@alice", "harassment")).json()).toMatchObject({ targetKind: "person" });
      // A group's existence isn't revealed: any group ID is taken.
      expect((await report(mod, "123456789012345")).json()).toMatchObject({ targetKind: "group" });

      const queue = await app.inject({ method: "GET", url: "/v1/admin/reports?status=open", headers: await as(admin) });
      const { reports, total } = queue.json();
      expect(total).toBe(4);
      const pekoReport = reports.find((r: { targetKind: string }) => r.targetKind === "peko");
      expect(pekoReport).toMatchObject({
        targetId: peko.hubId,
        reporter: { handle: "mod" },
        account: { id: alice.id, handle: "alice", suspended: false },
        targetRemoved: false,
      });
      const seedReport = reports.find((r: { targetKind: string }) => r.targetKind === "seed");
      expect(seedReport).toMatchObject({ note: "Tells people to run a shell script", account: { handle: "alice" } });
    });

    it("counts a repeat of an open report as the same report", async () => {
      await publish(alice, "1.0.0");
      const first = await report(mod, "alice/ada");
      const again = await report(mod, "alice/ada", "other");
      expect(again.statusCode).toBe(200);
      expect(again.json()).toMatchObject({ id: first.json().id, duplicate: true });
    });

    it("takes ten reports an hour from one account", async () => {
      for (let i = 0; i < 10; i++) {
        expect((await report(alice, String(1000 + i))).statusCode).toBe(201);
      }
      const limited = await report(alice, "2000");
      expect(limited.statusCode).toBe(429);
      expect(limited.headers["retry-after"]).toBe("3600");
      expect((await report(mod, "2000")).statusCode).toBe(201);
    });

    it("is dismissed or reopened by a moderator, who is recorded", async () => {
      const filed = (await report(alice, "42")).json();
      const res = await app.inject({
        method: "PATCH",
        url: `/v1/admin/reports/${filed.id}`,
        headers: await as(mod),
        payload: { status: "dismissed", resolution: "Not a violation" },
      });
      expect(res.statusCode).toBe(200);
      const [dismissed] = (
        await app.inject({ method: "GET", url: "/v1/admin/reports?status=dismissed", headers: await as(mod) })
      ).json().reports;
      expect(dismissed).toMatchObject({ resolvedBy: { handle: "mod" }, resolution: "Not a violation" });
      const missing = await app.inject({
        method: "PATCH",
        url: `/v1/admin/reports/${crypto.randomUUID()}`,
        headers: await as(mod),
        payload: { status: "dismissed" },
      });
      expect(missing.statusCode).toBe(404);
    });
  });

  describe("seed takedowns", () => {
    it("hides a seed everywhere and closes the report as actioned", async () => {
      await publish(alice, "1.0.0");
      const filed = (await report(mod, "alice/ada")).json();
      const hide = await app.inject({
        method: "POST",
        url: "/v1/admin/seeds/alice/ada/hide",
        headers: await as(mod),
        payload: { hidden: true, reason: "malware", reportId: filed.id },
      });
      expect(hide.statusCode).toBe(200);

      expect((await app.inject({ method: "GET", url: "/v1/seeds/alice/ada" })).statusCode).toBe(404);
      expect(
        (await app.inject({ method: "GET", url: "/v1/seeds/alice/ada/versions/1.0.0/seed.toml" })).statusCode,
      ).toBe(404);
      expect((await app.inject({ method: "GET", url: "/v1/seeds" })).json().total).toBe(0);
      const search = await app.inject({ method: "GET", url: "/v1/search?q=alice/ada" });
      expect(search.json()).toMatchObject({ exact: [], items: [] });

      // The publisher can't publish around it.
      const again = await app.inject({
        method: "POST",
        url: "/v1/seeds",
        headers: await as(alice),
        payload: { seed: SEED, version: "1.0.1" },
      });
      expect(again.statusCode).toBe(403);

      const [closed] = (
        await app.inject({ method: "GET", url: "/v1/admin/reports?status=actioned", headers: await as(mod) })
      ).json().reports;
      expect(closed).toMatchObject({ id: filed.id, targetRemoved: true, resolution: "Hid alice/ada" });
      expect((await moderationLog()).map((e) => e.action)).toEqual(["seed.hide", "report.actioned"]);

      await app.inject({
        method: "POST",
        url: "/v1/admin/seeds/alice/ada/hide",
        headers: await as(mod),
        payload: { hidden: false },
      });
      expect((await app.inject({ method: "GET", url: "/v1/seeds/alice/ada" })).statusCode).toBe(200);
    });

    it("yanks one version; the seed offers the rest", async () => {
      await publish(alice, "1.0.0");
      await publish(alice, "1.1.0");
      const yank = await app.inject({
        method: "POST",
        url: "/v1/admin/seeds/alice/ada/versions/1.1.0/yank",
        headers: await as(mod),
        payload: { yanked: true, reason: "leaks a key" },
      });
      expect(yank.json()).toEqual({ version: "1.1.0", yanked: true });

      const detail = (await app.inject({ method: "GET", url: "/v1/seeds/alice/ada" })).json();
      expect(detail.latestVersion).toBe("1.0.0");
      expect(detail.versions.map((v: { version: string }) => v.version)).toEqual(["1.0.0"]);
      expect(
        (await app.inject({ method: "GET", url: "/v1/seeds/alice/ada/versions/1.1.0/seed.toml" })).statusCode,
      ).toBe(404);
      // Versions are immutable: the yanked number stays taken.
      const reuse = await app.inject({
        method: "POST",
        url: "/v1/seeds",
        headers: await as(alice),
        payload: { seed: SEED, version: "1.1.0" },
      });
      expect(reuse.statusCode).toBe(409);
    });

    it("is for moderators only", async () => {
      await publish(alice, "1.0.0");
      const res = await app.inject({
        method: "POST",
        url: "/v1/admin/seeds/alice/ada/hide",
        headers: await as(alice),
        payload: { hidden: true },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe("peko takedowns", () => {
    it("forces a peko off the Hub down its tunnel, and keeps it off", async () => {
      const peko = await publicPeko(alice);
      vi.spyOn(app.tunnelManager, "isRuntimeConnected").mockReturnValue(true);
      const sendControl = vi.spyOn(app.tunnelRouter, "sendControl");

      const res = await app.inject({
        method: "POST",
        url: `/v1/admin/pekos/${peko.hubId}/takedown`,
        headers: await as(mod),
        payload: { takenDown: true, reason: "scam" },
      });
      expect(res.json()).toEqual({ takenDown: true, tunnelNotified: true });
      expect(sendControl).toHaveBeenCalledWith(peko.runtimeId, {
        type: "exposure_update",
        payload: { instanceId: peko.id, exposure: "local_only" },
      });
      expect((await app.inject({ method: "GET", url: "/v1/public/pekos/alice/ada" })).statusCode).toBe(404);

      // The owner can't put it back.
      const expose = await app.inject({
        method: "PATCH",
        url: `/v1/instances/${peko.id}/exposure`,
        headers: await as(alice),
        payload: { exposure: "public" },
      });
      expect(expose.statusCode).toBe(403);
      expect(await moderationLog()).toEqual([
        expect.objectContaining({ action: "peko.takedown", resource: "@alice/ada", user_id: mod.id }),
      ]);

      // Restored, the owner decides whether it goes back online.
      await app.inject({
        method: "POST",
        url: `/v1/admin/pekos/${peko.hubId}/takedown`,
        headers: await as(mod),
        payload: { takenDown: false },
      });
      const back = await app.inject({
        method: "PATCH",
        url: `/v1/instances/${peko.id}/exposure`,
        headers: await as(alice),
        payload: { exposure: "public" },
      });
      expect(back.statusCode).toBe(200);
    });

    it("is not found for an unknown Hub ID", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/v1/admin/pekos/${crypto.randomUUID()}/takedown`,
        headers: await as(mod),
        payload: { takenDown: true },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("suspensions", () => {
    it("locks the account out and closes its runtimes", async () => {
      await createRuntime(testDb.client, { ownerId: alice.id, runtimeDid: "did:key:alice-laptop" });
      await publicPeko(alice);
      await app.issueRefreshToken(alice.id);
      vi.spyOn(app.tunnelManager, "isRuntimeConnected").mockReturnValue(true);
      const disconnect = vi.spyOn(app.tunnelManager, "disconnectRuntime");
      const filed = (await report(mod, "@alice", "harassment")).json();

      const res = await app.inject({
        method: "POST",
        url: "/v1/admin/users/alice/suspend",
        headers: await as(mod),
        payload: { suspended: true, reason: "harassment", reportId: filed.id },
      });
      expect(res.json()).toEqual({ suspended: true, runtimesClosed: 1 });
      expect(disconnect).toHaveBeenCalledWith("did:key:alice-laptop", "account suspended");

      const me = await app.inject({ method: "GET", url: "/v1/auth/me", headers: await as(alice) });
      expect(me.statusCode).toBe(403);
      expect(me.json().error).toMatch(/suspended/);
      const seed = await app.inject({
        method: "POST",
        url: "/v1/seeds",
        headers: await as(alice),
        payload: { seed: SEED, version: "1.0.0" },
      });
      expect(seed.statusCode).toBe(401);
      const live = await testDb.client.query(
        "SELECT count(*)::int AS n FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL",
        [alice.id],
      );
      expect(live.rows[0]).toEqual({ n: 0 });
      expect((await app.inject({ method: "GET", url: "/v1/people/alice" })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: "/v1/public/pekos/alice/ada" })).statusCode).toBe(404);
      expect((await moderationLog()).map((e) => e.action)).toEqual(["account.suspend", "report.actioned"]);

      await app.inject({
        method: "POST",
        url: "/v1/admin/users/alice/suspend",
        headers: await as(mod),
        payload: { suspended: false },
      });
      expect((await app.inject({ method: "GET", url: "/v1/auth/me", headers: await as(alice) })).statusCode).toBe(200);
    });

    it("leaves staff to the roles above them, and no one suspends themselves", async () => {
      const other = await createUser(testDb.client, { namespace: "mod2", role: "moderator" });
      const suspend = (by: TestUser, who: string) =>
        as(by).then((headers) =>
          app.inject({ method: "POST", url: `/v1/admin/users/${who}/suspend`, headers, payload: { suspended: true } }),
        );
      expect((await suspend(mod, "mod2")).statusCode).toBe(403);
      expect((await suspend(mod, "boss")).statusCode).toBe(403);
      expect((await suspend(mod, "mod")).statusCode).toBe(403);
      expect((await suspend(admin, "boss")).statusCode).toBe(403);
      expect((await suspend(admin, other.id)).statusCode).toBe(200);
    });
  });
});
