import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

/**
 * Document-shape tests for the Meilisearch plugin.
 *
 * The route-level suites mock `fastify.search`, so they cannot see what
 * actually reaches Meilisearch. This boots the real plugin against a
 * stubbed client and inspects the documents.
 *
 * The regression these pin: Meilisearch infers a document's primary key
 * from its attributes, and it *fails the whole add task* when two
 * attributes end in `id`. Spreading the caller's `objectID` into the
 * document alongside the canonical `id` breaks indexing silently — the
 * route returns 201, the add task dies, and the seed never becomes
 * searchable. (Caught live, not by the mocked suites.)
 */

const addDocuments = vi.fn().mockResolvedValue({ taskUid: 1 });
const updateSettings = vi.fn().mockResolvedValue({ taskUid: 1 });
const deleteDocument = vi.fn().mockResolvedValue({ taskUid: 1 });
const search = vi.fn().mockResolvedValue({ hits: [], totalHits: 0, page: 0 });

vi.mock("meilisearch", () => ({
  MeiliSearch: class {
    index() {
      return { addDocuments, updateSettings, deleteDocument, search };
    }
  },
}));

const { default: searchPlugin } = await import("../search.js");

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorate("config", {
    MEILISEARCH_URL: "http://localhost:7700",
    MEILISEARCH_API_KEY: "test",
  } as never);
  await app.register(searchPlugin);
  await app.ready();
  return app;
}

describe("search plugin: indexed document shape", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    addDocuments.mockClear();
    if (!app) app = await buildApp();
  });

  it("indexes a seed with exactly one `*id` attribute", async () => {
    await app.search.indexBundle({
      objectID: "peko-principals-ada-1.0.0",
      namespace: "peko/principals",
      name: "ada",
      version: "1.0.0",
      description: "A research peko seed",
      author: "alice",
      bundleType: "principal",
      tags: ["research"],
      pullCount: 0,
      updatedAt: new Date().toISOString(),
    });

    expect(addDocuments).toHaveBeenCalledTimes(1);
    const [documents] = addDocuments.mock.calls[0];
    const doc = documents[0] as Record<string, unknown>;

    // The canonical key, sanitized for Meilisearch's attribute grammar
    // (only a-zA-Z0-9_- are allowed in document IDs).
    expect(doc.id).toBe("peko-principals-ada-1-0-0");
    expect(doc).not.toHaveProperty("objectID");

    // Count attributes ending in `id` — the number Meilisearch's
    // inference keyed on. More than one fails the task.
    const idFields = Object.keys(doc).filter((key) => key.endsWith("id"));
    expect(idFields).toEqual(["id"]);

    // Seed metadata survives intact.
    expect(doc).toMatchObject({
      namespace: "peko/principals",
      name: "ada",
      bundleType: "principal",
      tags: ["research"],
    });
  });

  it("never indexes an extension-era attribute", async () => {
    await app.search.indexBundle({
      objectID: "peko-principals-ada-1.0.0",
      namespace: "peko/principals",
      name: "ada",
      version: "1.0.0",
      author: "alice",
      bundleType: "principal",
      pullCount: 0,
      updatedAt: new Date().toISOString(),
    });

    const doc = addDocuments.mock.calls[0][0][0] as Record<string, unknown>;
    for (const field of [
      "extensionType",
      "hookPoints",
      "hooks",
      "compatibility",
      "compatibilityRuntime",
      "modelProviders",
      "requiredMcpServers",
      "categories",
      "starCount",
    ]) {
      expect(doc).not.toHaveProperty(field);
    }
  });
});
