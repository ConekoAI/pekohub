import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createTestDb, resetTables } from "../fixtures/db.js";
import { buildTestApp } from "../fixtures/app.js";
import { createBundle, createBundleVersion, createInstance, createUser } from "../fixtures/factories.js";
import type { TestDb } from "../fixtures/db.js";

describe("Search API", () => {
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

  describe("GET /v1/search", () => {
    it("coerces a null tags field instead of 500ing (Zod regression)", async () => {
      const app = await buildTestApp({ testDb });

      const bundle = await createBundle(testDb.client, {
        namespace: "peko/principals",
        name: "searchable-peko",
        description: "A searchable seed",
      });
      await createBundleVersion(testDb.client, bundle.id, {
        version: "1.0.0",
      });

      // A push whose metadata omitted tags leaves JSON null in the index.
      const row = bundle as any;
      await app.search.indexBundle({
        objectID: `${row.namespace}-${row.name}-1.0.0`,
        namespace: row.namespace,
        name: row.name,
        version: "1.0.0",
        description: row.description,
        author: row.author,
        bundleType: row.bundle_type,
        pullCount: row.pull_count,
        updatedAt: new Date().toISOString(),
        tags: null as any,
      });

      const response = await app.inject({
        method: "GET",
        url: "/v1/search?q=searchable",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.items).toHaveLength(1);
      // `tags` is coerced to undefined (omitted from JSON), not null.
      expect(body.items[0].tags).toBeUndefined();
      expect(body.items[0].name).toBe("searchable-peko");
    });

    it("returns seed metadata and no extension-era fields", async () => {
      const app = await buildTestApp({ testDb });

      const bundle = await createBundle(testDb.client, {
        namespace: "peko/principals",
        name: "tagged-peko",
        description: "A seed with tags",
        tags: ["research", "notes"],
      });
      await createBundleVersion(testDb.client, bundle.id, {
        version: "1.0.0",
      });

      const row = bundle as any;
      await app.search.indexBundle({
        objectID: `${row.namespace}-${row.name}-1.0.0`,
        namespace: row.namespace,
        name: row.name,
        version: "1.0.0",
        description: row.description,
        author: row.author,
        bundleType: row.bundle_type,
        pullCount: row.pull_count,
        updatedAt: new Date().toISOString(),
        tags: ["research", "notes"],
      });

      const response = await app.inject({
        method: "GET",
        url: "/v1/search?q=tagged",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.items[0].tags).toEqual(["research", "notes"]);
      expect(body.items[0].bundleType).toBe("principal");
      for (const field of [
        "extensionType",
        "hooks",
        "compatibility",
        "modelProviders",
        "requiredMcpServers",
        "categories",
        "forkedFrom",
        "starCount",
      ]) {
        expect(body.items[0]).not.toHaveProperty(field);
      }
    });
  });
});

describe("One search space: people, pekos and seeds (hub ADR-009)", () => {
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

  async function publishSeed(namespace: string, name: string, description: string) {
    const bundle = await createBundle(testDb.client, { namespace, name, description, tags: [] });
    await testDb.client.query(
      `INSERT INTO bundle_versions (bundle_id, version, digest, content, size) VALUES ($1, '1.2.0', 'sha256:0', 'name = "x"', 10)`,
      [bundle.id],
    );
    return bundle;
  }

  async function world() {
    const alice = await createUser(testDb.client, { namespace: "alice", displayName: "Alice" });
    const owner = { kind: "user", id: alice.id };
    await createInstance(testDb.client, { ownerSubject: owner, name: "ada", publicName: "Ada", description: "Research partner", exposure: "public", status: "online" });
    await createInstance(testDb.client, { ownerSubject: owner, name: "secret", description: "Research partner", exposure: "private" });
    await publishSeed("alice", "ada", "Reads research papers");
    await publishSeed("bob", "notes", "Keeps research notes");
    return buildTestApp({ testDb, postgresSearch: true });
  }

  const search = (app: Awaited<ReturnType<typeof buildTestApp>>, q: string) =>
    app.inject({ method: "GET", url: `/v1/search?q=${encodeURIComponent(q)}` });

  it("finds a person by exact handle, and only them", async () => {
    const app = await world();
    const body = (await search(app, "@Alice")).json();
    expect(body.queryKind).toBe("person");
    expect(body.exact).toEqual([
      expect.objectContaining({ kind: "person", id: "@alice", handle: "alice", displayName: "Alice", url: expect.stringMatching(/\/@alice$/) }),
    ]);
    expect(body.items).toEqual([]);
    expect((await search(app, "@ali")).json().exact).toEqual([]);
    await app.close();
  });

  it("finds a public peko by exact ID, never a private one or a partial match", async () => {
    const app = await world();
    const body = (await search(app, "@alice/ada")).json();
    expect(body.queryKind).toBe("peko");
    expect(body.exact).toEqual([
      expect.objectContaining({ kind: "peko", id: "@alice/ada", displayName: "Ada", status: "online", url: expect.stringMatching(/\/@alice\/ada$/) }),
    ]);
    expect(body.items).toEqual([]);
    for (const q of ["@alice/secret", "@alice/ad", "Ada", "Research partner", "alice"]) {
      const res = (await search(app, q)).json();
      expect(res.exact.filter((hit: { kind: string }) => hit.kind === "peko"), q).toEqual([]);
      expect(JSON.stringify(res), q).not.toContain("secret");
    }
    await app.close();
  });

  it("reads owner/name as a seed, and also shows the same-named public peko", async () => {
    const app = await world();
    const body = (await search(app, "alice/ada")).json();
    expect(body.queryKind).toBe("seed");
    expect(body.exact.map((hit: { kind: string; id: string }) => [hit.kind, hit.id])).toEqual([
      ["seed", "alice/ada"],
      ["peko", "@alice/ada"],
    ]);
    expect(body.exact[0]).toMatchObject({ version: "1.2.0", url: expect.stringMatching(/\/alice\/ada$/) });
    // The exact seed isn't repeated among the text matches.
    expect(body.items).toEqual([]);

    const versioned = (await search(app, "alice/ada@1.2.0")).json();
    expect(versioned.exact).toEqual([expect.objectContaining({ kind: "seed", id: "alice/ada@1.2.0", version: "1.2.0" })]);
    expect((await search(app, "alice/ada@9.9.9")).json().exact).toEqual([]);
    await app.close();
  });

  it("searches seeds by text, and nothing else", async () => {
    const app = await world();
    const body = (await search(app, "research")).json();
    expect(body.queryKind).toBe("text");
    expect(body.exact).toEqual([]);
    expect(body.items.map((item: { namespace: string; name: string }) => `${item.namespace}/${item.name}`).sort()).toEqual([
      "alice/ada",
      "bob/notes",
    ]);
    await app.close();
  });

  it("a person's page has their profile, by exact handle", async () => {
    const app = await world();
    const res = await app.inject({ method: "GET", url: "/v1/people/alice" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      kind: "person",
      id: "@alice",
      handle: "alice",
      displayName: "Alice",
      avatarUrl: expect.any(String),
      url: expect.stringMatching(/\/@alice$/),
      joinedAt: expect.any(String),
    });
    expect(JSON.stringify(res.json())).not.toContain("ada");
    expect((await app.inject({ method: "GET", url: "/v1/people/@alice" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/v1/people/ali" })).statusCode).toBe(404);
    await app.close();
  });
});
