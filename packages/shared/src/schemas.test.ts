import { describe, it, expect } from "vitest";
import { BundleMetadata, SearchQuery, SearchResultItem, SearchResponse } from "../src/schemas.js";
import { BundleTypes } from "../src/constants.js";
import { PrincipalName } from "../src/target-spec.js";

/**
 * Contract tests for the **seed-only** registry.
 *
 * Beyond the coercion behaviour these pin the *shape* of the contract:
 * the extension-era fields (`extensionType`, `hooks`, `compatibility`,
 * `modelProviders`, `requiredMcpServers`, `categories`, `forkedFrom`)
 * must not survive parsing, so the hub can never re-emit them even if a
 * stale client or a legacy row supplies them. Runtime ADR-037 retired
 * the `.agent`/`.ext` package formats, ADR-047 §5 made capabilities
 * plain workspace files, and ADR-050 deleted the extension framework's
 * management surface — there is no producer left for any of it.
 */

/** Every field the seed-only cut removed. */
const RETIRED_FIELDS = [
  "extensionType",
  "hooks",
  "compatibility",
  "modelProviders",
  "requiredMcpServers",
  "categories",
  "forkedFrom",
  "starCount",
] as const;

describe("BundleTypes is seed-only", () => {
  it("contains exactly one member", () => {
    expect(BundleTypes).toEqual(["principal"]);
  });
});

describe("nullishToUndefined coercion", () => {
  describe("SearchResultItem", () => {
    const validBase = {
      namespace: "peko/principals",
      name: "my-peko",
      version: "1.0.0",
      author: "test",
      bundleType: "principal",
      pullCount: 0,
      updatedAt: "2024-01-01T00:00:00Z",
    };

    it("accepts a seed item", () => {
      const result = SearchResultItem.safeParse(validBase);
      expect(result.success).toBe(true);
    });

    it("coerces tags: null → undefined", () => {
      const result = SearchResultItem.safeParse({ ...validBase, tags: null });
      expect(result.success).toBe(true);
      expect(result.data?.tags).toBeUndefined();
    });

    it("rejects a non-principal bundleType", () => {
      const result = SearchResultItem.safeParse({
        ...validBase,
        bundleType: "extension",
      });
      expect(result.success).toBe(false);
    });

    it("rejects tags: string (still type-safe)", () => {
      const result = SearchResultItem.safeParse({
        ...validBase,
        tags: "not-an-array",
      });
      expect(result.success).toBe(false);
    });

    it.each(RETIRED_FIELDS)("drops the retired %s field", (field) => {
      const result = SearchResultItem.safeParse({
        ...validBase,
        [field]: field === "starCount" ? 7 : [],
      });
      expect(result.success).toBe(true);
      expect(result.data).not.toHaveProperty(field);
    });
  });

  describe("SearchResponse", () => {
    it("accepts items with tags: null (regression)", () => {
      const result = SearchResponse.safeParse({
        items: [
          {
            namespace: "peko/principals",
            name: "my-peko",
            version: "1.0.0",
            author: "test",
            bundleType: "principal",
            pullCount: 0,
            updatedAt: "2024-01-01T00:00:00Z",
            tags: null,
          },
        ],
        total: 1,
        page: 1,
        perPage: 20,
        totalPages: 1,
      });
      expect(result.success).toBe(true);
      expect(result.data?.items[0].tags).toBeUndefined();
    });
  });

  describe("BundleMetadata", () => {
    const validBase = {
      name: "my-peko",
      author: "test",
      bundleType: "principal",
      version: "1.0.0",
    };

    it("coerces tags: null → undefined", () => {
      const result = BundleMetadata.safeParse({ ...validBase, tags: null });
      expect(result.success).toBe(true);
      expect(result.data?.tags).toBeUndefined();
    });

    it("preserves non-null tags", () => {
      const result = BundleMetadata.safeParse({
        ...validBase,
        tags: ["ai", "test"],
      });
      expect(result.success).toBe(true);
      expect(result.data?.tags).toHaveLength(2);
    });

    it("accepts the seed metadata surface", () => {
      const result = BundleMetadata.safeParse({
        ...validBase,
        description: "A research peko",
        license: "MIT",
        homepage: "https://example.com",
        repository: "https://github.com/example/peko",
        readme: "# Hi",
        deprecated: false,
      });
      expect(result.success).toBe(true);
    });

    it("rejects bundleType: extension", () => {
      const result = BundleMetadata.safeParse({
        ...validBase,
        bundleType: "extension",
      });
      expect(result.success).toBe(false);
    });

    it("rejects legacy bundleType: agent / team", () => {
      for (const bundleType of ["agent", "team"]) {
        expect(
          BundleMetadata.safeParse({ ...validBase, bundleType }).success,
        ).toBe(false);
      }
    });

    it.each(RETIRED_FIELDS)("drops the retired %s field", (field) => {
      const result = BundleMetadata.safeParse({
        ...validBase,
        [field]: field === "starCount" ? 7 : [],
      });
      expect(result.success).toBe(true);
      expect(result.data).not.toHaveProperty(field);
    });
  });
});

describe("SearchQuery filters are seed-only", () => {
  it("accepts the seed-only filter set", () => {
    const result = SearchQuery.safeParse({
      q: "ada",
      filters: { bundleType: "principal" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects bundleType: extension", () => {
    const result = SearchQuery.safeParse({
      q: "ada",
      filters: { bundleType: "extension" },
    });
    expect(result.success).toBe(false);
  });

  it.each(["extensionType", "modelProvider", "category", "license"])(
    "drops the retired %s filter",
    (field) => {
      const result = SearchQuery.safeParse({
        q: "ada",
        filters: { bundleType: "principal", [field]: "x" },
      });
      expect(result.success).toBe(true);
      expect(result.data?.filters).not.toHaveProperty(field);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// PrincipalName (runtime-aligned; peko-runtime's `validate_agent_name`)
// ─────────────────────────────────────────────────────────────────────────────

describe("PrincipalName (runtime-aligned)", () => {
  it.each([
    "a",
    "alice",
    "helper-1",
    "test_principal",
    "A1B2C3",
    "a".repeat(64), // exact max
  ])("accepts %s", (name) => {
    const result = PrincipalName.safeParse(name);
    expect(result.success).toBe(true);
  });

  it.each([
    "",
    "-leading",
    "trailing-",
    "has/slash",
    "has\\backslash",
    "has space",
    "has.dot",
    ".", // single dot
    "..", // double dot (path traversal)
    "..foo",
    "foo..",
    "foo..bar",
    "a".repeat(65), // over max
  ])("rejects %s", (name) => {
    const result = PrincipalName.safeParse(name);
    expect(result.success).toBe(false);
  });
});
