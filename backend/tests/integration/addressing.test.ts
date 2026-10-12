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

  it("routes the Hub ID and handle to the public host before private migration replicas", async () => {
    const app = await buildTestApp({ testDb });
    const user = await createUser(testDb.client, { namespace: "alice" });
    const ownerSubject = { kind: "user", id: user.id };
    const principalDid = "did:key:zCurrent";
    await createInstance(testDb.client, { ownerSubject, principalDid, name: "helper", exposure: "private", status: "offline" });
    const current = await createInstance(testDb.client, { ownerSubject, principalDid, name: "helper", exposure: "public", status: "online" });
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
    for (const url of [`/v1/principals/by-hub-id/${instance.hubId}`, "/v1/principals/by-handle/alice/helper"]) {
      expect((await app.inject({ method: "GET", url, headers })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(403);
    }
    expect((await app.inject({method: "GET", url: "/v1/public/pekos/alice/helper"})).statusCode).toBe(404);
    await app.close();
  });

  it("rejects ambiguous handles instead of choosing an arbitrary principal", async () => {
    const app = await buildTestApp({ testDb });
    const user = await createUser(testDb.client, { namespace: "alice" });
    for (const did of ["did:key:zOne", "did:key:zTwo"]) {
      await createInstance(testDb.client, { ownerSubject: { kind: "user", id: user.id }, principalDid: did, name: "helper", exposure: "public" });
    }
    for (const url of ["/v1/principals/by-handle/alice/helper", "/v1/public/pekos/alice/helper"]) {
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(409);
    }
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
