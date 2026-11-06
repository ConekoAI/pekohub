import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { createTestDb, resetTables, type TestDb } from "../fixtures/db.js";
import { createUser, createInstance } from "../fixtures/factories.js";
import { buildTestApp } from "../fixtures/app.js";
import { authHeaders } from "../fixtures/auth.js";

describe("actor addressing contract", () => {
  let testDb: TestDb;
  beforeAll(async () => { testDb = await createTestDb(); });
  beforeEach(async () => { await resetTables(testDb.client); });
  afterAll(async () => { await testDb.client.close(); });

  it("routes the Hub ID and handle to the principal's one linked host (ADR-081 D7)", async () => {
    const app = await buildTestApp({ testDb });
    const user = await createUser(testDb.client, { namespace: "alice" });
    const ownerSubject = { kind: "user", id: user.id };
    const principalDid = "did:key:zCurrent";
    const current = await createInstance(testDb.client, { ownerSubject, principalDid, name: "helper", exposure: "public", status: "online" });
    // A second ("migration replica") row for the same principal cannot exist.
    await expect(
      createInstance(testDb.client, { ownerSubject, principalDid, name: "helper", exposure: "private", status: "offline" }),
    ).rejects.toThrow();
    for (const url of [`/v1/principals/by-hub-id/${current.hubId}`, "/v1/principals/by-handle/alice/helper"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(200);
      expect(response.json().instanceId).toBe(current.id);
    }
    const profile = await app.inject({ method: "GET", url: "/v1/public/pekos/alice/helper" });
    expect(profile.json().liveInstance.id).toBe(current.id);
    await app.close();
  });

  it("registered private actors resolve for their owner and stay out of public profiles", async () => {
    const app = await buildTestApp({ testDb });
    const user = await createUser(testDb.client, { namespace: "alice" });
    const instance = await createInstance(testDb.client, { ownerSubject: { kind: "user", id: user.id }, principalDid: "did:key:zPrivate", name: "helper", exposure: "private" });
    const headers = await authHeaders(user);
    for (const [url, anonymous] of [[`/v1/principals/by-hub-id/${instance.hubId}`, 403], ["/v1/principals/by-handle/alice/helper", 404]] as const) {
      expect((await app.inject({ method: "GET", url, headers })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(anonymous);
    }
    expect((await app.inject({method: "GET", url: "/v1/public/pekos/alice/helper"})).statusCode).toBe(404);
    await app.close();
  });

  it("a handle shared by two public pekos means the one made public last (hub ADR-009 D3)", async () => {
    const app = await buildTestApp({ testDb });
    const user = await createUser(testDb.client, { namespace: "alice" });
    const ownerSubject = { kind: "user", id: user.id };
    const older = await createInstance(testDb.client, { ownerSubject, principalDid: "did:key:zOne", name: "helper", exposure: "public", publishedAt: new Date("2026-10-01T00:00:00Z") });
    const newer = await createInstance(testDb.client, { ownerSubject, principalDid: "did:key:zTwo", name: "helper", exposure: "public", publishedAt: new Date("2026-10-02T00:00:00Z") });
    const resolve = async () => {
      const directory = await app.inject({ method: "GET", url: "/v1/principals/by-handle/alice/helper" });
      const profile = await app.inject({ method: "GET", url: "/v1/public/pekos/alice/helper" });
      expect(directory.statusCode).toBe(200);
      expect(profile.json().liveInstance.id).toBe(directory.json().instanceId);
      return directory.json().instanceId;
    };
    expect(await resolve()).toBe(newer.id);

    // Made private, the newer one gives the handle back; made public
    // again, it takes it back.
    const headers = await authHeaders(user);
    const exposure = (id: string, to: string) =>
      app.inject({ method: "PATCH", url: `/v1/instances/${id}/exposure`, headers, payload: { exposure: to } });
    expect((await exposure(newer.id, "private")).statusCode).toBe(200);
    expect(await resolve()).toBe(older.id);
    expect((await exposure(newer.id, "public")).statusCode).toBe(200);
    expect(await resolve()).toBe(newer.id);
    await app.close();
  });

  function proof(path: string, overrides: Record<string, unknown> = {}) {
    const { secretKey, publicKey } = ed25519.keygen();
    const sub = `did:key:z${base58.encode(new Uint8Array([0xed, 0x01, ...publicKey]))}`;
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub, aud: "peko-directory-v1", path, iat: now, exp: now + 60, ...overrides })).toString("base64url");
    const input = `${header}.${payload}`;
    return { sub, authorization: `PekoPrincipal ${input}.${Buffer.from(ed25519.sign(new TextEncoder().encode(input), secretKey)).toString("base64url")}` };
  }

  it("verifies principal directory proof and leaves private-chat authorization to the recipient", async () => {
    const app = await buildTestApp({ testDb });
    const user = await createUser(testDb.client, { namespace: "alice" });
    const target = await createInstance(testDb.client, { ownerSubject: { kind: "user", id: user.id }, principalDid: "did:key:zPrivate", name: "helper", exposure: "private" });
    const url = `/v1/principals/by-hub-id/${target.hubId}`;
    const caller = proof(url);
    await testDb.client.query("INSERT INTO hub_principals(signing_did,identity_key) VALUES($1,$1)", [caller.sub]);
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url, headers: { authorization: caller.authorization } })).statusCode).toBe(200);
    for (const authorization of [proof("/wrong/path").authorization, proof(url, { exp: 1 }).authorization, proof(url, { aud: "wrong" }).authorization, "PekoPrincipal invalid"]) {
      expect((await app.inject({ method: "GET", url, headers: { authorization } })).statusCode).toBe(401);
    }
    await app.close();
  });

  /** A registered peko's signing key: a directory proof per request path. */
  function signer() {
    const { secretKey, publicKey } = ed25519.keygen();
    const sub = `did:key:z${base58.encode(new Uint8Array([0xed, 0x01, ...publicKey]))}`;
    return {
      sub,
      headers(path: string) {
        const now = Math.floor(Date.now() / 1000);
        const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url");
        const payload = Buffer.from(JSON.stringify({ sub, aud: "peko-directory-v1", path, iat: now, exp: now + 60 })).toString("base64url");
        const input = `${header}.${payload}`;
        const signature = Buffer.from(ed25519.sign(new TextEncoder().encode(input), secretKey)).toString("base64url");
        return { authorization: `PekoPrincipal ${input}.${signature}` };
      },
    };
  }

  it("a private peko's handle resolves only for its owner; its Hub ID for anyone signed in (hub ADR-010)", async () => {
    const app = await buildTestApp({ testDb });
    const alice = await createUser(testDb.client, { namespace: "alice" });
    const bob = await createUser(testDb.client, { namespace: "bob" });
    const target = await createInstance(testDb.client, { ownerSubject: { kind: "user", id: alice.id }, principalDid: "did:key:zTarget", name: "helper", exposure: "private" });
    // Alice's peko on her other computer, and a peko of Bob's.
    const alicesPeko = signer();
    await createInstance(testDb.client, { ownerSubject: { kind: "user", id: alice.id }, principalDid: alicesPeko.sub, name: "scout", exposure: "private" });
    const bobsPeko = signer();
    await createInstance(testDb.client, { ownerSubject: { kind: "user", id: bob.id }, principalDid: bobsPeko.sub, name: "pal", exposure: "private" });
    const aliceHeaders = await authHeaders(alice);
    const bobHeaders = await authHeaders(bob);

    const byHubId = `/v1/principals/by-hub-id/${target.hubId}`;
    const byHandle = "/v1/principals/by-handle/alice/helper";
    const status = async (url: string, headers?: Record<string, string>) =>
      (await app.inject({ method: "GET", url, headers })).statusCode;

    // Its owner, as the person or as one of her pekos.
    for (const url of [byHubId, byHandle]) {
      expect(await status(url, aliceHeaders)).toBe(200);
      expect(await status(url, alicesPeko.headers(url))).toBe(200);
    }
    // By handle, everyone else learns nothing — not even that it exists.
    expect(await status(byHandle)).toBe(404);
    expect(await status(byHandle, bobHeaders)).toBe(404);
    expect(await status(byHandle, bobsPeko.headers(byHandle))).toBe(404);
    // By Hub ID — the address its owner hands out — other accounts and
    // pekos still reach it (first contact, group invitations, person
    // DMs, the desktop's DM list); its runtime enforces chat grants.
    expect(await status(byHubId)).toBe(403);
    expect(await status(byHubId, bobHeaders)).toBe(200);
    expect(await status(byHubId, bobsPeko.headers(byHubId))).toBe(200);
    await app.close();
  });

  it("keeps authenticated account and anonymous visitor chat identities distinct", async () => {
    const app = await buildTestApp({ testDb });
    const owner = await createUser(testDb.client, { namespace: "alice" });
    const caller = await createUser(testDb.client, { namespace: "bob" });
    await createInstance(testDb.client, { ownerSubject: { kind: "user", id: owner.id }, name: "helper", exposure: "public", status: "online" });
    const proxy = vi.spyOn(app.tunnelRouter, "proxyStream").mockImplementation(async (_runtime, _instance, _name, _body, _headers, reply) => reply.send({ ok: true }));
    const url = "/v1/public/pekos/alice/helper/chat";
    expect((await app.inject({ method: "POST", url, payload: { message: "hi" }, headers: await authHeaders(caller) })).statusCode).toBe(200);
    const signed = proxy.mock.calls[0] as unknown[];
    expect(signed[6]).toEqual({ kind: "user", id: caller.id });
    expect(signed[7]).toBeNull();
    expect((await app.inject({ method: "POST", url, payload: { message: "hi" } })).statusCode).toBe(200);
    const anonymous = proxy.mock.calls[1] as unknown[];
    expect(anonymous[6]).toBeNull();
    expect(typeof anonymous[7]).toBe("string");
    expect((await app.inject({ method: "POST", url, payload: { message: "hi" }, headers: { authorization: "Bearer invalid" } })).statusCode).toBe(401);
    expect(proxy).toHaveBeenCalledTimes(2);
    await app.close();
  });
});
