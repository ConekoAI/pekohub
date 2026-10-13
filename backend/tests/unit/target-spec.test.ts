import { describe, it, expect } from "vitest";
import {
  TargetSpec,
  RemoteByHubId,
  RemoteByHandle,
  parseTargetSpecPath,
  formatTargetSpecPath,
} from "@pekohub/shared";

// ─────────────────────────────────────────────────────────────────────────────
// TargetSpec — unit tests
//
// The shared schema and path-segment codec is the wire contract between
// pekohub and peko-runtime's cross-runtime `a2a_send` resolver
// ([peko-runtime#29]). These tests pin the parser down so future
// refactors don't silently change the on-the-wire format.
// ─────────────────────────────────────────────────────────────────────────────

describe("TargetSpec schema", () => {
  it("accepts a by-hub-id spec", () => {
    const parsed = RemoteByHubId.parse({
      kind: "by-hub-id",
      hubId: "12345678-1234-4234-8234-123456789abc",
    });
    expect(parsed.kind).toBe("by-hub-id");
    expect(parsed.hubId).toBe("12345678-1234-4234-8234-123456789abc");
  });

  it("accepts a by-hub-id spec with runtime-id hint", () => {
    const parsed = RemoteByHubId.parse({
      kind: "by-hub-id",
      hubId: "12345678-1234-4234-8234-123456789abc",
      runtimeIdHint: "runtime-42",
    });
    expect(parsed.hubId).toBe("12345678-1234-4234-8234-123456789abc");
  });

  it("rejects an empty DID", () => {
    expect(() => RemoteByHubId.parse({ kind: "by-hub-id", hubId: "" })).toThrow();
  });

  it("accepts a by-handle spec", () => {
    const parsed = RemoteByHandle.parse({
      kind: "by-handle",
      owner: "alice",
      principalName: "helper",
    });
    expect(parsed.owner).toBe("alice");
    expect(parsed.principalName).toBe("helper");
  });

  it("rejects an invalid namespace", () => {
    // Must start with lowercase alphanumeric, then [a-z0-9_-]*.
    expect(() =>
      RemoteByHandle.parse({
        kind: "by-handle",
        owner: "Alice", // uppercase
        principalName: "helper",
      }),
    ).toThrow();
    expect(() =>
      RemoteByHandle.parse({
        kind: "by-handle",
        owner: "-alice", // leading dash
        principalName: "helper",
      }),
    ).toThrow();
  });

  it("rejects an empty agent name", () => {
    expect(() =>
      RemoteByHandle.parse({
        kind: "by-handle",
        owner: "alice",
        principalName: "",
      }),
    ).toThrow();
  });

  it("discriminates by kind in the union", () => {
    const byDid = TargetSpec.parse({
      kind: "by-hub-id",
      hubId: "12345678-1234-4234-8234-123456789abc",
    });
    const byHandle = TargetSpec.parse({
      kind: "by-handle",
      owner: "bob",
      principalName: "agent",
    });
    expect(byDid.kind).toBe("by-hub-id");
    expect(byHandle.kind).toBe("by-handle");
  });
});

describe("formatTargetSpecPath", () => {
  it("encodes a by-hub-id spec as the raw DID", () => {
    const s = formatTargetSpecPath({
      kind: "by-hub-id",
      hubId: "12345678-1234-4234-8234-123456789abc",
    });
    expect(s).toBe("12345678-1234-4234-8234-123456789abc");
  });

  it("encodes a by-handle spec as `owner/principal_name`", () => {
    const s = formatTargetSpecPath({
      kind: "by-handle",
      owner: "alice",
      principalName: "helper",
    });
    expect(s).toBe("alice/helper");
  });
});

describe("parseTargetSpecPath", () => {
  it("parses a Hub UUID", () => {
    const spec = parseTargetSpecPath("12345678-1234-4234-8234-123456789abc");
    expect(spec).toEqual({
      kind: "by-hub-id",
      hubId: "12345678-1234-4234-8234-123456789abc",
    });
  });

  it("parses a handle", () => {
    const spec = parseTargetSpecPath("alice/helper");
    expect(spec).toEqual({
      kind: "by-handle",
      owner: "alice",
      principalName: "helper",
    });
  });

  it("round-trips by-hub-id and by-handle", () => {
    const byDid = {
      kind: "by-hub-id" as const,
      hubId: "12345678-1234-4234-8234-123456789abc",
    };
    expect(parseTargetSpecPath(formatTargetSpecPath(byDid))).toEqual(byDid);

    const byHandle = {
      kind: "by-handle" as const,
      owner: "alice",
      principalName: "code-reviewer",
    };
    expect(parseTargetSpecPath(formatTargetSpecPath(byHandle))).toEqual(
      byHandle,
    );
  });

  it("rejects an empty string", () => {
    expect(parseTargetSpecPath("")).toBeNull();
  });

  it("rejects a handle without a slash", () => {
    expect(parseTargetSpecPath("alice")).toBeNull();
  });

  it("rejects a handle with an empty owner or name", () => {
    expect(parseTargetSpecPath("/helper")).toBeNull();
    expect(parseTargetSpecPath("alice/")).toBeNull();
  });
});
