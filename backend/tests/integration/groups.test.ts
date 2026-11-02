import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { SignJWT, importJWK } from "jose";
import { ed25519 } from "@noble/curves/ed25519.js";
import { createTestDb, resetTables } from "../fixtures/db.js";
import { buildTestApp } from "../fixtures/app.js";
import { createUser, createInstance } from "../fixtures/factories.js";
import { authHeaders } from "../fixtures/auth.js";
import { makeRuntimeIdentity, seedRuntime } from "../fixtures/tunnel.js";
import { registerGroup, setGroupRoster, INVITE_TOKEN_VERSION } from "../../src/services/groups.js";
import type { TestDb } from "../fixtures/db.js";

// Runtime ADR-092 D5/D6: a group's page shows a public group to anyone, an
// invite-only one only with an invite its home signed; a person sees their
// own groups.

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

async function invite(home: { did: string; privateKey: Uint8Array }, claims: Record<string, unknown>) {
  const jwk = await importJWK(
    { kty: "OKP", crv: "Ed25519", x: b64url(ed25519.getPublicKey(home.privateKey)), d: b64url(home.privateKey) },
    "EdDSA",
  );
  return new SignJWT(claims).setProtectedHeader({ alg: "EdDSA" }).sign(jwk);
}

describe("Group pages and your groups", () => {
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

  async function setup(visibility: "invite_only" | "public") {
    const owner = await createUser(testDb.client, { namespace: "alice", displayName: "Alice" });
    const member = await createUser(testDb.client, { namespace: "bob" });
    const home = makeRuntimeIdentity();
    await seedRuntime(testDb, home.did, owner.id);
    const peko = await createInstance(testDb.client, {
      ownerSubject: { kind: "user", id: String(owner.id) },
      name: "host",
      publicName: "Host",
      exposure: "public",
      runtimeId: home.did,
    } as never);
    const id = await registerGroup({
      homeRuntime: home.did,
      channelId: "chan_book",
      name: "book club",
      ownerAddress: `principal:hub:${peko.hubId}`,
      visibility,
    });
    return { owner, member, home, id };
  }

  it("shows a public group to anyone", async () => {
    const { id, home } = await setup("public");
    const res = await app.inject({ method: "GET", url: `/v1/groups/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id,
      name: "book club",
      visibility: "public",
      owner: { kind: "peko", name: "Host", handle: "@alice/host" },
      homeRuntime: home.did,
      channelId: "chan_book",
    });
  });

  it("shows an invite-only group only with an unexpired invite its home signed", async () => {
    const { id, home } = await setup("invite_only");
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const claims = { v: INVITE_TOKEN_VERSION, g: id, c: "chan_book", h: home.did, exp, n: "x" };
    const get = (q = "") => app.inject({ method: "GET", url: `/v1/groups/${id}${q}` });

    expect((await get()).statusCode).toBe(404);
    expect((await get(`?invite=${await invite(home, claims)}`)).statusCode).toBe(200);
    const stranger = makeRuntimeIdentity();
    expect((await get(`?invite=${await invite(stranger, claims)}`)).statusCode).toBe(404);
    expect((await get(`?invite=${await invite(home, { ...claims, exp: exp - 7200 })}`)).statusCode).toBe(404);
    expect((await get(`?invite=${await invite(home, { ...claims, g: "1" })}`)).statusCode).toBe(404);
  });

  it("lists your own groups, only to you", async () => {
    const { id, member, home } = await setup("invite_only");
    await setGroupRoster(home.did, id, [member.id]);
    expect((await app.inject({ method: "GET", url: "/v1/me/groups" })).statusCode).toBe(401);
    const res = await app.inject({ method: "GET", url: "/v1/me/groups", headers: await authHeaders(member) });
    expect(res.json()).toEqual({
      groups: [{ groupId: id, name: "book club", homeRuntime: home.did, channelId: "chan_book" }],
    });
  });

  it("asks a visitor to sign in before reading a group's history", async () => {
    const { id } = await setup("public");
    const res = await app.inject({ method: "GET", url: `/v1/groups/${id}/history` });
    expect(res.statusCode).toBe(401);
  });
});
