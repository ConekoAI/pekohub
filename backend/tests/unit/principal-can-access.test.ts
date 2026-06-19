/**
 * Unit tests for issue #11's `principalCanAccess` helper and the
 * `resolveOwnerPrincipal` backfill shim.
 *
 * Pure functions — no DB, no Fastify. Mirrors the peko-runtime
 * ADR-039 back-compat test pattern (`auth::ownership::tests` in
 * `peko-runtime/src/auth/ownership.rs`).
 */

import { describe, it, expect } from "vitest";
import type { Principal } from "@pekohub/shared";
import {
  instanceService,
  principalCanAccess,
  resolveOwnerPrincipal,
  type CallerPrincipal,
  type InstanceRecord,
} from "../../src/services/instances.js";

// Minimal InstanceRecord stub — only the fields the helpers actually
// read. The `type: "agent" as const` is required because the
// InstanceRecord type is strictly `"agent" | "team"`.
function makeInstance(overrides: {
  ownerId?: number;
  ownerPrincipal?: Principal | null;
  allowedUsers?: string[];
  allowedPrincipals?: Principal[];
  exposure?: InstanceRecord["exposure"];
  status?: InstanceRecord["status"];
} = {}): Pick<
  InstanceRecord,
  "ownerId" | "ownerPrincipal" | "allowedUsers" | "allowedPrincipals"
> {
  return {
    ownerId: overrides.ownerId ?? 0,
    ownerPrincipal:
      overrides.ownerPrincipal !== undefined
        ? overrides.ownerPrincipal
        : null,
    allowedUsers: overrides.allowedUsers ?? [],
    allowedPrincipals: overrides.allowedPrincipals ?? [],
  };
}

// ── principalCanAccess ──────────────────────────────────────────────────────

describe("principalCanAccess", () => {
  describe("public owner", () => {
    it("allows any caller (including null and cross-kind)", async () => {
      const owner: Principal = { kind: "public" };
      expect(await principalCanAccess(owner, null)).toBe(true);
      expect(
        await principalCanAccess(owner, { kind: "user", id: "1" }),
      ).toBe(true);
      expect(
        await principalCanAccess(owner, { kind: "agent", id: "x" }),
      ).toBe(true);
      expect(await principalCanAccess(owner, { kind: "public" })).toBe(true);
    });
  });

  describe("user owner", () => {
    it("allows the matching user", async () => {
      const owner: Principal = { kind: "user", id: "42" };
      expect(
        await principalCanAccess(owner, { kind: "user", id: "42" }),
      ).toBe(true);
    });

    it("denies a different user", async () => {
      const owner: Principal = { kind: "user", id: "42" };
      expect(
        await principalCanAccess(owner, { kind: "user", id: "99" }),
      ).toBe(false);
    });

    // The cross-kind guard is the whole point of the typed-principal
    // model — the legacy `subject_id: String` form allowed
    // `User("alice") == Agent("alice")` because they were both
    // strings. The new model makes the kind tag part of equality.
    it("denies an agent with the same id string (cross-kind guard)", async () => {
      const owner: Principal = { kind: "user", id: "alice" };
      expect(
        await principalCanAccess(owner, { kind: "agent", id: "alice" }),
      ).toBe(false);
    });

    it("denies a public-kind caller (only public owners are public-readable)", async () => {
      const owner: Principal = { kind: "user", id: "42" };
      expect(await principalCanAccess(owner, { kind: "public" })).toBe(false);
    });

    it("denies null caller", async () => {
      const owner: Principal = { kind: "user", id: "42" };
      expect(await principalCanAccess(owner, null)).toBe(false);
    });
  });

  describe("agent owner", () => {
    it("allows the matching agent", async () => {
      const owner: Principal = { kind: "agent", id: "helper" };
      expect(
        await principalCanAccess(owner, { kind: "agent", id: "helper" }),
      ).toBe(true);
    });

    it("denies a different agent", async () => {
      const owner: Principal = { kind: "agent", id: "helper" };
      expect(
        await principalCanAccess(owner, { kind: "agent", id: "other" }),
      ).toBe(false);
    });

    it("denies a user caller (even one with the same id string)", async () => {
      const owner: Principal = { kind: "agent", id: "helper" };
      expect(
        await principalCanAccess(owner, { kind: "user", id: "helper" }),
      ).toBe(false);
    });

    it("denies null caller", async () => {
      const owner: Principal = { kind: "agent", id: "helper" };
      expect(await principalCanAccess(owner, null)).toBe(false);
    });
  });

  describe("team owner", () => {
    it("allows a user caller that's a team member", async () => {
      const owner: Principal = { kind: "team", id: "eng" };
      const members = async (_id: string): Promise<string[]> => ["42", "99"];
      expect(
        await principalCanAccess(owner, { kind: "user", id: "42" }, members),
      ).toBe(true);
    });

    it("denies a user caller that's NOT a team member", async () => {
      const owner: Principal = { kind: "team", id: "eng" };
      const members = async (_id: string): Promise<string[]> => ["42"];
      expect(
        await principalCanAccess(owner, { kind: "user", id: "99" }, members),
      ).toBe(false);
    });

    it("denies a non-user caller (teams resolve to user members)", async () => {
      const owner: Principal = { kind: "team", id: "eng" };
      expect(
        await principalCanAccess(owner, { kind: "agent", id: "helper" }),
      ).toBe(false);
    });

    // Default teamMembersOf returns []. The safe default is "deny" —
    // a Team-owned instance denies everyone until the team-membership
    // table lands. This is intentional and gated on peko-runtime#11.
    it("denies everyone when team membership is unknown (stub)", async () => {
      const owner: Principal = { kind: "team", id: "eng" };
      expect(
        await principalCanAccess(owner, { kind: "user", id: "42" }),
      ).toBe(false);
    });
  });

  describe("legacy numeric userId coercion (back-compat shim)", () => {
    it("accepts numeric userId for canAccess", async () => {
      const instance = makeInstance({
        ownerId: 42,
        ownerPrincipal: { kind: "user", id: "42" },
      });
      expect(await instanceService.canAccess(instance, 42)).toBe(true);
      expect(await instanceService.canAccess(instance, 99)).toBe(false);
    });

    it("accepts numeric userId for isOwner", async () => {
      const instance = makeInstance({
        ownerId: 42,
        ownerPrincipal: { kind: "user", id: "42" },
      });
      expect(await instanceService.isOwner(instance, 42)).toBe(true);
      expect(await instanceService.isOwner(instance, 99)).toBe(false);
    });
  });
});

// ── resolveOwnerPrincipal (backfill shim) ──────────────────────────────────

describe("resolveOwnerPrincipal", () => {
  it("returns the typed owner when present and non-sentinel", () => {
    const instance = makeInstance({
      ownerId: 99, // would resolve to User("99") if backfilled
      ownerPrincipal: { kind: "agent", id: "helper" },
    });
    expect(resolveOwnerPrincipal(instance)).toEqual({
      kind: "agent",
      id: "helper",
    });
  });

  it("falls back to legacy ownerId when owner_principal is null", () => {
    const instance = makeInstance({
      ownerId: 42,
      ownerPrincipal: null,
    });
    expect(resolveOwnerPrincipal(instance)).toEqual({
      kind: "user",
      id: "42",
    });
  });

  // The runtime migration backfills empty-sentinel
  // `Principal::User("")` on legacy rows. The shim must treat this
  // the same as a null `owner_principal` — fall back to the legacy
  // `ownerId`. Without this, the strict `instance.ownerId !== user.id`
  // check would reject every backfilled instance.
  it("falls back to legacy ownerId when owner_principal is the empty sentinel", () => {
    const instance = makeInstance({
      ownerId: 42,
      ownerPrincipal: { kind: "user", id: "" },
    });
    expect(resolveOwnerPrincipal(instance)).toEqual({
      kind: "user",
      id: "42",
    });
  });

  it("returns null when both owner_principal and ownerId are empty", () => {
    const instance = makeInstance({
      ownerId: 0,
      ownerPrincipal: null,
    });
    expect(resolveOwnerPrincipal(instance)).toBeNull();
  });

  it("preserves Team and Public typed owners without falling back", () => {
    expect(
      resolveOwnerPrincipal(
        makeInstance({
          ownerId: 42,
          ownerPrincipal: { kind: "team", id: "eng" },
        }),
      ),
    ).toEqual({ kind: "team", id: "eng" });

    expect(
      resolveOwnerPrincipal(
        makeInstance({
          ownerId: 42,
          ownerPrincipal: { kind: "public" },
        }),
      ),
    ).toEqual({ kind: "public" });
  });
});

// ── canAccess / canChat with the new typed allow-list ──────────────────────

describe("canAccess — typed allow-list (allowedPrincipals)", () => {
  it("allows a user caller whose principal is in allowedPrincipals", async () => {
    const instance = makeInstance({
      ownerId: 1,
      ownerPrincipal: { kind: "user", id: "1" },
      allowedPrincipals: [
        { kind: "user", id: "7" },
        { kind: "agent", id: "helper" },
      ],
    });
    // Owner (1) is allowed
    expect(await instanceService.canAccess(instance, 1)).toBe(true);
    // Allowed user (7)
    expect(await instanceService.canAccess(instance, 7)).toBe(true);
    // Allowed agent
    const caller: CallerPrincipal = { kind: "agent", id: "helper" };
    expect(await instanceService.canAccess(instance, caller)).toBe(true);
  });

  it("denies a caller that's not in either allow-list", async () => {
    const instance = makeInstance({
      ownerId: 1,
      ownerPrincipal: { kind: "user", id: "1" },
      allowedPrincipals: [{ kind: "user", id: "7" }],
    });
    expect(await instanceService.canAccess(instance, 99)).toBe(false);
  });

  it("respects the legacy allowedUsers column (User-kind only)", async () => {
    const instance = makeInstance({
      ownerId: 1,
      ownerPrincipal: { kind: "user", id: "1" },
      allowedUsers: ["42"],
    });
    expect(await instanceService.canAccess(instance, 42)).toBe(true);
    expect(await instanceService.canAccess(instance, 99)).toBe(false);
  });
});

// ── Issue #11 acceptance smoke tests ───────────────────────────────────────

describe("issue #11 acceptance smoke tests", () => {
  it("Agent caller can access Agent-owned instance", async () => {
    const owner: Principal = { kind: "agent", id: "helper" };
    const caller: CallerPrincipal = { kind: "agent", id: "helper" };
    expect(await principalCanAccess(owner, caller)).toBe(true);
  });

  it("Agent caller cannot access a different Agent-owned instance", async () => {
    const owner: Principal = { kind: "agent", id: "helper" };
    const caller: CallerPrincipal = { kind: "agent", id: "other" };
    expect(await principalCanAccess(owner, caller)).toBe(false);
  });

  it("backfilled User(\"\") sentinel resolves to the legacy User owner", () => {
    // Pre-#11 row that the runtime has now touched — the runtime
    // wrote the empty sentinel to `owner_principal` but the
    // pre-existing `owner_id` is the real legacy owner.
    const instance = makeInstance({
      ownerId: 7,
      ownerPrincipal: { kind: "user", id: "" },
    });
    const owner = resolveOwnerPrincipal(instance);
    expect(owner).toEqual({ kind: "user", id: "7" });
    // And the access check matches a User caller with that numeric id.
    expect(
      principalCanAccess(owner!, { kind: "user", id: "7" }),
    ).resolves.toBe(true);
  });
});
