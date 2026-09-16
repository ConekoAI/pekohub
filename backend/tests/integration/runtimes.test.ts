import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { SignJWT, importJWK } from "jose";
import { createTestDb, resetTables } from "../fixtures/db.js";
import { buildTestApp } from "../fixtures/app.js";
import { createUser } from "../fixtures/factories.js";
import { authHeaders } from "../fixtures/auth.js";
import type { TestDb } from "../fixtures/db.js";

// ─────────────────────────────────────────────────────────────────────────────
// ADR-058 D4: POST /v1/runtimes/register requires proof of possession of
// the claimed runtime DID's Ed25519 key.
//
// Contract under test:
//   1. POST /v1/runtimes/register-challenge → { nonce, exp } (single-use,
//      ~60s TTL).
//   2. POST /v1/runtimes/register with body { runtime_did, pop: { nonce,
//      jws } } where jws is a compact EdDSA JWS over canonical JSON
//      {"nonce","runtimeDid","owner","iat","exp"} signed with the
//      claimed DID's key.
// ─────────────────────────────────────────────────────────────────────────────

const ED25519_PUB_MULTICODEC = new Uint8Array([0xed, 0x01]);

function makeDidKey(): { did: string; secretKey: Uint8Array; publicKey: Uint8Array } {
  const { secretKey } = ed25519.keygen();
  const publicKey = ed25519.getPublicKey(secretKey);
  const encoded = base58.encode(
    new Uint8Array([...ED25519_PUB_MULTICODEC, ...publicKey]),
  );
  return { did: `did:key:z${encoded}`, secretKey, publicKey };
}

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** Sign a compact JWS with an Ed25519 keypair. Payload keys are in the
 *  canonical contract order: nonce, runtimeDid, owner, iat, exp. */
async function signPop(
  key: { secretKey: Uint8Array; publicKey: Uint8Array },
  payload: Record<string, unknown>,
): Promise<string> {
  const jwk = await importJWK(
    {
      kty: "OKP",
      crv: "Ed25519",
      x: b64url(key.publicKey),
      d: b64url(key.secretKey),
    },
    "EdDSA",
  );
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "EdDSA" })
    .sign(jwk);
}

function canonicalPopPayload(
  nonce: string,
  runtimeDid: string,
  owner: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    nonce,
    runtimeDid,
    owner,
    iat: now,
    exp: now + 60,
    ...overrides,
  };
}

describe("Runtime registration PoP (ADR-058 D4)", () => {
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

  async function getChallenge(
    app: Awaited<ReturnType<typeof buildTestApp>>,
    headers: { Authorization: string },
  ): Promise<{ nonce: string; exp: number }> {
    const response = await app.inject({
      method: "POST",
      url: "/v1/runtimes/register-challenge",
      headers,
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(typeof body.nonce).toBe("string");
    expect(typeof body.exp).toBe("number");
    return body;
  }

  it("rejects a register body with no pop", async () => {
    const app = await buildTestApp({ testDb });
    const user = await createUser(testDb.client, { namespace: "alice" });
    const headers = await authHeaders(user);
    const { did } = makeDidKey();

    const response = await app.inject({
      method: "POST",
      url: "/v1/runtimes/register",
      headers,
      payload: { runtime_did: did },
    });
    expect(response.statusCode).toBe(400);
  });

  it("registers a runtime with a valid pop", async () => {
    const app = await buildTestApp({ testDb });
    const user = await createUser(testDb.client, { namespace: "alice" });
    const headers = await authHeaders(user);
    const key = makeDidKey();

    const { nonce } = await getChallenge(app, headers);
    const jws = await signPop(
      key,
      canonicalPopPayload(nonce, key.did, String(user.id)),
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/runtimes/register",
      headers,
      payload: { runtime_did: key.did, pop: { nonce, jws } },
    });
    expect(response.statusCode).toBe(200);
    const row = JSON.parse(response.payload);
    expect(row.runtimeDid).toBe(key.did);
    expect(row.ownerId).toBe(String(user.id));
  });

  it("rejects a pop signed with the wrong key", async () => {
    const app = await buildTestApp({ testDb });
    const user = await createUser(testDb.client, { namespace: "alice" });
    const headers = await authHeaders(user);
    const claimed = makeDidKey();
    const attacker = makeDidKey();

    const { nonce } = await getChallenge(app, headers);
    // Attacker signs with THEIR key but claims the victim's DID.
    const jws = await signPop(
      attacker,
      canonicalPopPayload(nonce, claimed.did, String(user.id)),
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/runtimes/register",
      headers,
      payload: { runtime_did: claimed.did, pop: { nonce, jws } },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.payload).error).toBe("invalid_pop_signature");
  });

  it("rejects nonce reuse (single-use challenges)", async () => {
    const app = await buildTestApp({ testDb });
    const user = await createUser(testDb.client, { namespace: "alice" });
    const headers = await authHeaders(user);
    const key = makeDidKey();

    const { nonce } = await getChallenge(app, headers);
    const jws = await signPop(
      key,
      canonicalPopPayload(nonce, key.did, String(user.id)),
    );
    const payload = { runtime_did: key.did, pop: { nonce, jws } };

    const first = await app.inject({
      method: "POST",
      url: "/v1/runtimes/register",
      headers,
      payload,
    });
    expect(first.statusCode).toBe(200);

    const replay = await app.inject({
      method: "POST",
      url: "/v1/runtimes/register",
      headers,
      payload,
    });
    expect(replay.statusCode).toBe(400);
    expect(JSON.parse(replay.payload).error).toBe("invalid_pop_nonce");
  });

  it("rejects an unknown nonce", async () => {
    const app = await buildTestApp({ testDb });
    const user = await createUser(testDb.client, { namespace: "alice" });
    const headers = await authHeaders(user);
    const key = makeDidKey();

    const nonce = "never-issued";
    const jws = await signPop(
      key,
      canonicalPopPayload(nonce, key.did, String(user.id)),
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/runtimes/register",
      headers,
      payload: { runtime_did: key.did, pop: { nonce, jws } },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.payload).error).toBe("invalid_pop_nonce");
  });

  it("rejects a pop whose owner claim does not match the caller", async () => {
    const app = await buildTestApp({ testDb });
    const user = await createUser(testDb.client, { namespace: "alice" });
    const headers = await authHeaders(user);
    const key = makeDidKey();

    const { nonce } = await getChallenge(app, headers);
    const jws = await signPop(
      key,
      canonicalPopPayload(nonce, key.did, "someone-else"),
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/runtimes/register",
      headers,
      payload: { runtime_did: key.did, pop: { nonce, jws } },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.payload).error).toBe("invalid_pop_claims");
  });

  it("rejects a stale pop (expired exp)", async () => {
    const app = await buildTestApp({ testDb });
    const user = await createUser(testDb.client, { namespace: "alice" });
    const headers = await authHeaders(user);
    const key = makeDidKey();

    const { nonce } = await getChallenge(app, headers);
    const now = Math.floor(Date.now() / 1000);
    const jws = await signPop(
      key,
      canonicalPopPayload(nonce, key.did, String(user.id), {
        iat: now - 120,
        exp: now - 60,
      }),
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/runtimes/register",
      headers,
      payload: { runtime_did: key.did, pop: { nonce, jws } },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.payload).error).toBe("invalid_pop_freshness");
  });
});
