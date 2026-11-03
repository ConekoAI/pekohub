import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import { createTestDb } from "../fixtures/db.js";
import { buildTestApp } from "../fixtures/app.js";
import type { TestDb } from "../fixtures/db.js";
import { apiErrorHandler } from "../../src/plugins/errors.js";
import { createUser } from "../fixtures/factories.js";
import { authHeaders } from "../fixtures/auth.js";
import bcrypt from "bcryptjs";
import { createHash } from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────────
// A request that isn't signed in gets 401, never 500; a server failure says
// only that it failed.
// ─────────────────────────────────────────────────────────────────────────────

describe("API errors", () => {
  let testDb: TestDb;
  let app: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    testDb = await createTestDb();
    app = await buildTestApp({ testDb });
  });

  afterAll(async () => {
    await app.close();
    await testDb.client.close();
  });

  it.each([
    ["no credentials", {}],
    ["a bad API key", { authorization: "Bearer pkr_000000notakey" }],
    ["a malformed JWT", { authorization: "Bearer not.a.jwt" }],
  ])("signed-in routes answer 401 to %s", async (_label, headers) => {
    for (const [method, url] of [
      ["GET", "/v1/auth/api-keys"],
      ["POST", "/v1/auth/api-keys"],
      ["DELETE", "/v1/auth/api-keys/1"],
      ["GET", "/v1/admin/audit?namespace=alice"],
    ] as const) {
      const response = await app.inject({ method, url, headers, payload: method === "POST" ? { name: "k" } : undefined });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it("a server failure doesn't leak its message", async () => {
    const bare = Fastify({ logger: false });
    bare.setErrorHandler(apiErrorHandler);
    bare.get("/boom", async () => {
      throw new Error('relation "secret_table" does not exist');
    });
    bare.get("/teapot", async () => {
      throw Object.assign(new Error("Send { name }"), { statusCode: 400 });
    });

    const boom = await bare.inject({ method: "GET", url: "/boom" });
    expect(boom.statusCode).toBe(500);
    expect(boom.json()).toEqual({ error: "Internal Server Error" });

    const bad = await bare.inject({ method: "GET", url: "/teapot" });
    expect(bad.json()).toEqual({ error: "Send { name }" });
    await bare.close();
  });
});

describe("API keys", () => {
  let testDb: TestDb;
  let app: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    testDb = await createTestDb();
    app = await buildTestApp({ testDb });
  });

  afterAll(async () => {
    await app.close();
    await testDb.client.close();
  });

  it("a new key signs in, is stored as SHA-256, and stops working once revoked", async () => {
    const user = await createUser(testDb.client, { namespace: "keyholder" });
    const made = await app.inject({
      method: "POST",
      url: "/v1/auth/api-keys",
      headers: await authHeaders(user),
      payload: { name: "ci" },
    });
    expect(made.statusCode).toBe(201);
    const { key, prefix, id } = made.json();
    expect(key).toMatch(/^pkr_[0-9a-f]{12}[A-Za-z0-9_-]{24}$/);
    expect(prefix).toBe(key.slice(0, 16));
    const stored = await testDb.client.query("SELECT hash FROM api_keys WHERE id = $1", [id]);
    expect(stored.rows[0].hash).toMatch(/^[0-9a-f]{64}$/);

    const asKey = { authorization: `Bearer ${key}` };
    expect((await app.inject({ method: "GET", url: "/v1/auth/api-keys", headers: asKey })).statusCode).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/v1/auth/api-keys", headers: { authorization: `Bearer ${key}x` } }))
        .statusCode,
    ).toBe(401);

    await app.inject({ method: "DELETE", url: `/v1/auth/api-keys/${id}`, headers: asKey });
    expect((await app.inject({ method: "GET", url: "/v1/auth/api-keys", headers: asKey })).statusCode).toBe(401);
  });

  it("a key made before SHA-256 still signs in and is rehashed", async () => {
    const user = await createUser(testDb.client, { namespace: "oldkey" });
    const key = "pkr_abc123" + "s".repeat(24);
    await testDb.client.query(
      "INSERT INTO api_keys (user_id, name, prefix, hash) VALUES ($1, 'old', $2, $3)",
      [user.id, key.slice(0, 10), await bcrypt.hash(key, 4)],
    );

    const res = await app.inject({ method: "GET", url: "/v1/auth/api-keys", headers: { authorization: `Bearer ${key}` } });
    expect(res.statusCode).toBe(200);
    const stored = await testDb.client.query("SELECT hash FROM api_keys WHERE prefix = $1", [key.slice(0, 10)]);
    expect(stored.rows[0].hash).toBe(createHash("sha256").update(key).digest("hex"));
    expect(
      (await app.inject({ method: "GET", url: "/v1/auth/api-keys", headers: { authorization: `Bearer ${key}` } }))
        .statusCode,
    ).toBe(200);
  });
});
