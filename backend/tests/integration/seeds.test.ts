import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createTestDb, resetTables } from "../fixtures/db.js";
import { buildTestApp } from "../fixtures/app.js";
import { createUser } from "../fixtures/factories.js";
import { authHeaders } from "../fixtures/auth.js";
import type { TestDb } from "../fixtures/db.js";

// The seed registry (gap map S1): publish TOML, read it back, grow it
// with `peko create -s`. Versions are immutable; only the publisher
// changes a seed.

const SEED = `name = "ada"
preferred_model_id = "claude-opus-5-5"

[identity]
display_name = "Ada"
description = "Reads papers and keeps notes"
avatar = "🦉"
`;

describe("Seed registry", () => {
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

  async function publish(headers: { Authorization: string }, version: string, seed = SEED) {
    return app.inject({
      method: "POST",
      url: "/v1/seeds",
      headers,
      payload: { seed, version, readme: "# Ada\nA research partner." },
    });
  }

  it("publishes under the publisher's handle and serves it back", async () => {
    const alice = await createUser(testDb.client, { namespace: "alice", displayName: "Alice" });
    const res = await publish(await authHeaders(alice), "1.0.0");
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ owner: "alice", name: "ada", version: "1.0.0" });
    expect(body.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(body.downloadUrl).toMatch(/\/v1\/seeds\/alice\/ada\/versions\/1\.0\.0\/seed\.toml$/);
    expect(body.webUrl).toMatch(/\/seeds\/alice\/ada$/);

    const detail = await app.inject({ method: "GET", url: "/v1/seeds/alice/ada" });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      owner: { handle: "alice", displayName: "Alice" },
      name: "ada",
      displayName: "Ada",
      description: "Reads papers and keeps notes",
      avatar: "🦉",
      model: "claude-opus-5-5",
      readme: "# Ada\nA research partner.",
      latestVersion: "1.0.0",
      content: SEED,
      createCommand: "peko create my-ada -s ada.seed.toml",
    });

    const list = await app.inject({ method: "GET", url: "/v1/seeds" });
    expect(list.json()).toMatchObject({ total: 1, items: [{ owner: "alice", name: "ada", displayName: "Ada" }] });
  });

  it("downloads a version as a .seed.toml file and counts the pull", async () => {
    const alice = await createUser(testDb.client, { namespace: "alice" });
    await publish(await authHeaders(alice), "1.0.0");

    for (const version of ["1.0.0", "latest"]) {
      const res = await app.inject({
        method: "GET",
        url: `/v1/seeds/alice/ada/versions/${version}/seed.toml`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("application/toml");
      expect(res.headers["content-disposition"]).toBe('attachment; filename="ada.seed.toml"');
      expect(res.body).toBe(SEED);
    }
    const detail = await app.inject({ method: "GET", url: "/v1/seeds/alice/ada" });
    expect(detail.json().pullCount.allTime).toBeGreaterThanOrEqual(1);

    const missing = await app.inject({ method: "GET", url: "/v1/seeds/alice/ada/versions/9.9.9/seed.toml" });
    expect(missing.statusCode).toBe(404);
  });

  it("refuses unsigned, invalid, identity-bearing, and repeated publishes", async () => {
    const alice = await createUser(testDb.client, { namespace: "alice" });
    const headers = await authHeaders(alice);

    const anonymous = await app.inject({ method: "POST", url: "/v1/seeds", payload: { seed: SEED, version: "1.0.0" } });
    expect(anonymous.statusCode).toBe(401);

    const badVersion = await publish(headers, "latest");
    expect(badVersion.statusCode).toBe(422);

    const identity = await publish(headers, "1.0.0", `did = "did:key:z6Mk"\n${SEED}`);
    expect(identity.statusCode).toBe(422);
    expect(identity.json().error).toContain("`did`");

    expect((await publish(headers, "1.0.0")).statusCode).toBe(201);
    const again = await publish(headers, "1.0.0");
    expect(again.statusCode).toBe(409);
  });

  it("only the publisher deprecates or deletes; the latest skips deprecated versions", async () => {
    const alice = await createUser(testDb.client, { namespace: "alice" });
    const bob = await createUser(testDb.client, { namespace: "bob" });
    const aliceHeaders = await authHeaders(alice);
    await publish(aliceHeaders, "1.0.0");
    await publish(aliceHeaders, "1.1.0", SEED.replace("Reads papers", "Reads more papers"));

    const bobDeprecate = await app.inject({
      method: "POST",
      url: "/v1/seeds/alice/ada/versions/1.1.0/deprecate",
      headers: await authHeaders(bob),
      payload: { deprecated: true },
    });
    expect(bobDeprecate.statusCode).toBe(403);

    const deprecate = await app.inject({
      method: "POST",
      url: "/v1/seeds/alice/ada/versions/1.1.0/deprecate",
      headers: aliceHeaders,
      payload: { deprecated: true, message: "broke the persona" },
    });
    expect(deprecate.statusCode).toBe(200);
    const detail = (await app.inject({ method: "GET", url: "/v1/seeds/alice/ada" })).json();
    expect(detail.latestVersion).toBe("1.0.0");
    expect(detail.versions.find((v: { version: string }) => v.version === "1.1.0").deprecated).toBe(true);

    const deleteVersion = await app.inject({
      method: "DELETE",
      url: "/v1/seeds/alice/ada/versions/1.1.0",
      headers: aliceHeaders,
    });
    expect(deleteVersion.statusCode).toBe(204);
    const lastVersion = await app.inject({
      method: "DELETE",
      url: "/v1/seeds/alice/ada/versions/1.0.0",
      headers: aliceHeaders,
    });
    expect(lastVersion.statusCode).toBe(409);

    expect(
      (await app.inject({ method: "DELETE", url: "/v1/seeds/alice/ada", headers: await authHeaders(bob) })).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: "DELETE", url: "/v1/seeds/alice/ada", headers: aliceHeaders })).statusCode,
    ).toBe(204);
    expect((await app.inject({ method: "GET", url: "/v1/seeds/alice/ada" })).statusCode).toBe(404);
  });

  it("the public OCI surface is gone", async () => {
    for (const url of ["/v2/", "/v2/_catalog", "/v1/bundles/alice/ada", "/api/v1/search?q=a"]) {
      expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(404);
    }
  });
});
