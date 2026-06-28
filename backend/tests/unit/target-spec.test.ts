import { describe, it, expect } from "vitest";
import {
  TargetSpec,
  RemoteByDID,
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
  it("accepts a by-did spec", () => {
    const parsed = RemoteByDID.parse({
      kind: "by-did",
      did: "did:peko:agent:abc123",
    });
    expect(parsed.kind).toBe("by-did");
    expect(parsed.did).toBe("did:peko:agent:abc123");
  });

  it("accepts a by-did spec with runtime-id hint", () => {
    const parsed = RemoteByDID.parse({
      kind: "by-did",
      did: "did:peko:agent:abc123",
      runtimeIdHint: "runtime-42",
    });
    expect(parsed.runtimeIdHint).toBe("runtime-42");
  });

  it("rejects an empty DID", () => {
    expect(() => RemoteByDID.parse({ kind: "by-did", did: "" })).toThrow();
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
      kind: "by-did",
      did: "did:peko:agent:xyz",
    });
    const byHandle = TargetSpec.parse({
      kind: "by-handle",
      owner: "bob",
      principalName: "agent",
    });
    expect(byDid.kind).toBe("by-did");
    expect(byHandle.kind).toBe("by-handle");
  });
});

describe("formatTargetSpecPath", () => {
  it("encodes a by-did spec as the raw DID", () => {
    const s = formatTargetSpecPath({
      kind: "by-did",
      did: "did:peko:agent:abc123",
    });
    expect(s).toBe("did:peko:agent:abc123");
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
  it("parses a DID", () => {
    const spec = parseTargetSpecPath("did:peko:agent:abc123");
    expect(spec).toEqual({
      kind: "by-did",
      did: "did:peko:agent:abc123",
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

  it("round-trips by-did and by-handle", () => {
    const byDid = {
      kind: "by-did" as const,
      did: "did:peko:principal:deadbeef",
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
