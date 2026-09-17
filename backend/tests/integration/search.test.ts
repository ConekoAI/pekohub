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
