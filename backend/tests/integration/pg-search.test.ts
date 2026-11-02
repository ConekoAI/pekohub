import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createTestDb, resetTables } from "../fixtures/db.js";
import { createBundle } from "../fixtures/factories.js";
import type { TestDb } from "../fixtures/db.js";
import { createPostgresSearch, parseFilters } from "../../src/services/pg-search.js";
import type { SearchService } from "../../src/plugins/search.js";

// Search without Meilisearch: the same SearchService, read straight from
// Postgres, so a deployment can run with nothing but a database.

describe("Postgres search", () => {
  let testDb: TestDb;
  let search: SearchService;

  beforeAll(async () => {
    testDb = await createTestDb();
    search = createPostgresSearch(testDb.db as never);
  });

  beforeEach(async () => {
    await resetTables(testDb.client);
  });

  afterAll(async () => {
    await testDb.client.close();
  });

  async function seed(name: string, description: string, versions: Array<[string, boolean]>) {
    const bundle = await createBundle(testDb.client, {
      namespace: "alice",
      name,
      description,
      author: "Alice",
      tags: ["research"],
    });
    for (const [version, deprecated] of versions) {
      await testDb.client.query(
        `INSERT INTO bundle_versions (bundle_id, version, digest, content, size, deprecated)
         VALUES ($1, $2, 'sha256:0', 'name = "x"', 10, $3)`,
        [bundle.id, version, deprecated],
      );
    }
    return bundle;
  }

  it("finds seeds by every word, offering the newest live version", async () => {
    await seed("ada", "Reads papers and keeps notes", [["1.0.0", false], ["2.0.0", true]]);
    await seed("bob", "Plans trips", [["1.0.0", false]]);

    const result = await search.search("papers NOTES", {
      filter: ["bundleType = principal"],
      hitsPerPage: 10,
    });
    expect(result.total).toBe(1);
    expect(result.page).toBe(1);
    expect(result.hits[0]).toMatchObject({
      namespace: "alice",
      name: "ada",
      version: "1.0.0",
      author: "Alice",
      bundleType: "principal",
      tags: ["research"],
    });

    expect((await search.search("papers trips")).total).toBe(0);
    expect((await search.search("")).total).toBe(2);
  });

  it("offers each seed its own version, whatever the row ids", async () => {
    // Ids interleave: one seed's version row id equals the other seed's id.
    await seed("ada", "Reads papers", [["1.2.0", false]]);
    await seed("bob", "Reads papers too", [["0.1.0", false]]);
    await seed("cy", "Reads papers three", [["3.0.0", false]]);
    const result = await search.search("papers");
    expect(Object.fromEntries(result.hits.map((hit) => [hit.name, hit.version]))).toEqual({
      ada: "1.2.0",
      bob: "0.1.0",
      cy: "3.0.0",
    });
  });

  it("matches a query literally, not as a LIKE pattern", async () => {
    await seed("ada", "Reads papers", [["1.0.0", false]]);
    expect((await search.search("%")).total).toBe(0);
    expect((await search.search("_")).total).toBe(0);
  });

  it("leaves out seeds with no text version", async () => {
    await createBundle(testDb.client, { namespace: "alice", name: "legacy" });
    expect((await search.search("")).total).toBe(0);
  });

  it("refuses a filter it can't express", async () => {
    expect(parseFilters(["a = b", ["c = 'd'"]])).toEqual([["a", "b"], ["c", "d"]]);
    await expect(search.search("", { filter: ["exposure = public"] })).rejects.toThrow(
      /unsupported search filter field/,
    );
    await expect(search.search("", { filter: ["bundleType > 1"] })).rejects.toThrow(
      /unsupported search filter/,
    );
  });
});
