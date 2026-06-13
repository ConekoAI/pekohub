import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createTestDb, resetTables } from "../fixtures/db.js";
import { buildTestApp } from "../fixtures/app.js";
import { createBundle, createBundleVersion } from "../fixtures/factories.js";
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
    it("should return 200 when a result has hooks: null in Meilisearch (issue #001)", async () => {
      const app = await buildTestApp({ testDb });

      // 1. Create a bundle with hooks explicitly set to null (simulates a
      //    push whose metadata omitted the hooks field).
      const bundle = await createBundle(testDb.client, {
        namespace: "acme",
        name: "searchable-agent",
        description: "A searchable test agent",
        hooks: null as any, // factory stores JSON null in DB
      });
      await createBundleVersion(testDb.client, bundle.id, {
        version: "1.0.0",
      });

      // 2. Index into the mock search service (mimics what OCI manifest push does).
      //    The mock search stores the doc verbatim, so if hooks is null it stays null.
      //    Note: PGlite returns snake_case column names, so we map them explicitly.
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
        starCount: row.star_count,
        updatedAt: new Date().toISOString(),
        hooks: null, // simulate Meilisearch doc with null hooks
      });

      // 3. Search — before the fix this would 500 with a Zod error:
      //    "Expected array, received null" at items[0].hooks
      const response = await app.inject({
        method: "GET",
        url: "/v1/search?q=searchable",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.items).toHaveLength(1);
      // hooks should be coerced to undefined (omitted from JSON), not null
      expect(body.items[0].hooks).toBeUndefined();
      expect(body.items[0].name).toBe("searchable-agent");
    });

    it("should preserve non-empty hooks arrays in search results", async () => {
      const app = await buildTestApp({ testDb });

      const bundle = await createBundle(testDb.client, {
        namespace: "acme",
        name: "hooked-agent",
        description: "An agent with hooks",
        hooks: [{ point: "agent.init", handler: "onInit" }],
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
        starCount: row.star_count,
        updatedAt: new Date().toISOString(),
        hooks: [{ point: "agent.init", handler: "onInit" }],
      });

      const response = await app.inject({
        method: "GET",
        url: "/v1/search?q=hooked",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.items).toHaveLength(1);
      expect(body.items[0].hooks).toHaveLength(1);
      expect(body.items[0].hooks[0]).toMatchObject({
        point: "agent.init",
        handler: "onInit",
      });
    });
  });
});
