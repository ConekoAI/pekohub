import { describe, it, expect } from "vitest";
import {
  SearchResultItem,
  SearchResponse,
  BundleMetadata,
  HookPoint,
} from "../src/schemas.js";

describe("nullishToUndefined coercion", () => {
  describe("SearchResultItem", () => {
    const validBase = {
      namespace: "acme",
      name: "test-agent",
      version: "1.0.0",
      author: "test",
      bundleType: "agent",
      pullCount: 0,
      starCount: 0,
      updatedAt: "2024-01-01T00:00:00Z",
    };

    it("accepts hooks as an array", () => {
      const result = SearchResultItem.safeParse({
        ...validBase,
        hooks: [{ point: "agent.init", handler: "onInit" }],
      });
      expect(result.success).toBe(true);
      expect(result.data?.hooks).toHaveLength(1);
    });

    it("accepts missing hooks (undefined)", () => {
      const result = SearchResultItem.safeParse(validBase);
      expect(result.success).toBe(true);
      expect(result.data?.hooks).toBeUndefined();
    });

    it("coerces hooks: null → undefined (the 500 bug fix)", () => {
      const result = SearchResultItem.safeParse({
        ...validBase,
        hooks: null,
      });
      expect(result.success).toBe(true);
      expect(result.data?.hooks).toBeUndefined();
    });

    it("coerces tags: null → undefined", () => {
      const result = SearchResultItem.safeParse({
        ...validBase,
        tags: null,
      });
      expect(result.success).toBe(true);
      expect(result.data?.tags).toBeUndefined();
    });

    it("rejects hooks: string (still type-safe)", () => {
      const result = SearchResultItem.safeParse({
        ...validBase,
        hooks: "not-an-array",
      });
      expect(result.success).toBe(false);
    });

    it("rejects invalid hook point values", () => {
      const result = SearchResultItem.safeParse({
        ...validBase,
        hooks: [{ point: "invalid.point", handler: "x" }],
      });
      expect(result.success).toBe(false);
    });
  });

  describe("SearchResponse", () => {
    it("accepts items with hooks: null (regression)", () => {
      const result = SearchResponse.safeParse({
        items: [
          {
            namespace: "acme",
            name: "agent",
            version: "1.0.0",
            author: "test",
            bundleType: "agent",
            pullCount: 0,
            starCount: 0,
            updatedAt: "2024-01-01T00:00:00Z",
            hooks: null,
          },
        ],
        total: 1,
        page: 1,
        perPage: 20,
        totalPages: 1,
      });
      expect(result.success).toBe(true);
      expect(result.data?.items[0].hooks).toBeUndefined();
    });
  });

  describe("BundleMetadata", () => {
    const validBase = {
      name: "my-bundle",
      author: "test",
      bundleType: "agent",
      version: "1.0.0",
    };

    it("coerces hooks: null → undefined", () => {
      const result = BundleMetadata.safeParse({
        ...validBase,
        hooks: null,
      });
      expect(result.success).toBe(true);
      expect(result.data?.hooks).toBeUndefined();
    });

    it("coerces tags: null → undefined", () => {
      const result = BundleMetadata.safeParse({
        ...validBase,
        tags: null,
      });
      expect(result.success).toBe(true);
      expect(result.data?.tags).toBeUndefined();
    });

    it("coerces categories: null → undefined", () => {
      const result = BundleMetadata.safeParse({
        ...validBase,
        categories: null,
      });
      expect(result.success).toBe(true);
      expect(result.data?.categories).toBeUndefined();
    });

    it("coerces modelProviders: null → undefined", () => {
      const result = BundleMetadata.safeParse({
        ...validBase,
        modelProviders: null,
      });
      expect(result.success).toBe(true);
      expect(result.data?.modelProviders).toBeUndefined();
    });

    it("coerces requiredMcpServers: null → undefined", () => {
      const result = BundleMetadata.safeParse({
        ...validBase,
        requiredMcpServers: null,
      });
      expect(result.success).toBe(true);
      expect(result.data?.requiredMcpServers).toBeUndefined();
    });

    it("preserves non-null arrays", () => {
      const result = BundleMetadata.safeParse({
        ...validBase,
        hooks: [{ point: "agent.init" as HookPoint, handler: "init" }],
        tags: ["ai", "test"],
      });
      expect(result.success).toBe(true);
      expect(result.data?.hooks).toHaveLength(1);
      expect(result.data?.tags).toHaveLength(2);
    });
  });
});
