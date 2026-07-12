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
      bundleType: "principal",
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
            bundleType: "principal",
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
      bundleType: "principal",
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

// ─────────────────────────────────────────────────────────────────────────────
// HookPoint — runtime-aligned (peko-runtime/src/extensions/framework/core/hook_points.rs)
// ─────────────────────────────────────────────────────────────────────────────

describe("HookPoint (runtime-aligned)", () => {
  it.each([
    // Base form — all 23 runtime hook point names
    "agent.init",
    "agent.shutdown",
    "agent.iteration",
    "tool.register",
    "tool.execute",
    "tool.execute_async",
    "tool.check_status",
    "tool.cancel",
    "tool.result_transform",
    "prompt.system_section",
    "prompt.pre_process",
    "prompt.post_process",
    "session.state_change",
    "session.compaction",
    "session.context_build",
    "session.compaction_post",
    "session.start",
    "io.channel_input",
    "io.channel_output",
    "io.message_pre_send",
    "io.message_post_receive",
    "event.subscribe",
    "event.emit",
  ])("accepts base form %s", (point) => {
    const result = BundleMetadata.safeParse({
      name: "x",
      author: "t",
      bundleType: "principal",
      version: "1.0.0",
      hooks: [{ point }],
    });
    expect(result.success).toBe(true);
  });

  it.each([
    // Parameterized form — runtime HookPoint::name() with concrete suffix
    "prompt.system_section.skills",
    "tool.execute.Read",
    "tool.execute_async.shell",
    "tool.check_status.Agent",
    "tool.cancel.long_task",
    "event.subscribe.instance.created",
    "agent.iteration.3",
  ])("accepts parameterized form %s", (point) => {
    const result = BundleMetadata.safeParse({
      name: "x",
      author: "t",
      bundleType: "principal",
      version: "1.0.0",
      hooks: [{ point }],
    });
    expect(result.success).toBe(true);
  });

  it.each([
    // Wildcard form — runtime HookPoint::matches() patterns
    "tool.execute.*",
    "session.*",
    "agent.*",
  ])("accepts wildcard form %s", (point) => {
    const result = BundleMetadata.safeParse({
      name: "x",
      author: "t",
      bundleType: "principal",
      version: "1.0.0",
      hooks: [{ point }],
    });
    expect(result.success).toBe(true);
  });

  it.each([
    // Reject: anything outside the six runtime hook categories
    "invalid.point",
    "principal.init", // speculative principal-layer hooks (not yet in runtime)
    "principal.shutdown",
    "principal.session.gc",
    "memory.store", // invented — runtime has no memory hook layer
    "mcp.toolDiscover",
    "cron.schedule",
    // Reject: wrong casing / wrong separators
    "Agent.Init",
    "tool.Execute",
    "prompt-system-section",
    "tool/execute",
    // Reject: 4+ segments
    "tool.execute.foo.bar",
    // Reject: bare category / bare extension name
    "agent",
    "tool",
    "",
  ])("rejects invalid hook point %s", (point) => {
    const result = BundleMetadata.safeParse({
      name: "x",
      author: "t",
      bundleType: "principal",
      version: "1.0.0",
      hooks: [{ point }],
    });
    expect(result.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ExtensionType — all 7 standard peko-runtime types + custom:<id>
// ─────────────────────────────────────────────────────────────────────────────

describe("ExtensionType (runtime-aligned)", () => {
  it.each([
    "skill",
    "agent",
    "slash",
    "mcp",
    "universal-tool",
    "gateway",
    "general",
  ])("accepts standard type %s", (extType) => {
    const result = BundleMetadata.safeParse({
      name: "x",
      author: "t",
      bundleType: "extension",
      version: "1.0.0",
      extensionType: extType,
    });
    expect(result.success).toBe(true);
  });

  it.each([
    "custom:my-org/skill",
    "custom:internal",
    "custom:a",
    "custom:my-org/skill.v2",
    "custom:a_b",
  ])("accepts custom:<id> form %s", (extType) => {
    const result = BundleMetadata.safeParse({
      name: "x",
      author: "t",
      bundleType: "extension",
      version: "1.0.0",
      extensionType: extType,
    });
    expect(result.success).toBe(true);
  });

  it.each([
    "builtin", // intentionally absent — runtime mod.rs:145-146
    "universal", // renamed to universal-tool in runtime
    "agent-team", // not a valid type
    "custom:", // empty id
    "custom:MyOrg/Skill", // uppercase not allowed
    "custom:foo bar", // space not allowed
    "CUSTOM:foo",
    "team", // pre-ADR-041 type
  ])("rejects invalid extension type %s", (extType) => {
    const result = BundleMetadata.safeParse({
      name: "x",
      author: "t",
      bundleType: "extension",
      version: "1.0.0",
      extensionType: extType,
    });
    expect(result.success).toBe(false);
  });
});
