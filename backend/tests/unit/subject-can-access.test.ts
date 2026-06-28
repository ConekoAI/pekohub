/**
 * Unit tests for ADR-041's `subjectCanAccess` helper and the
 * `resolveOwnerSubject` backfill shim.
 *
 * Pure functions — no DB, no Fastify. Mirrors the peko-runtime
 * ADR-039 back-compat test pattern (`auth::ownership::tests` in
 * `peko-runtime/src/auth/ownership.rs`).
 *
 * ADR-041 removed the `Team` subject variant, so there is no
 * "team owner" describe block — all access is `User` / `Principal`
 * / `Public`.
 */

import { describe, it, expect } from "vitest";
import type { Subject } from "@pekohub/shared";
import {
  instanceService,
  subjectCanAccess,
  resolveOwnerSubject,
  type CallerSubject,
  type InstanceRecord,
} from "../../src/services/instances.js";

// Minimal InstanceRecord stub — only the fields the helpers actually
// read. The `type: "principal"` literal matches the post-ADR-041
// schema.
function makeInstance(overrides: {
  ownerId?: number;
  ownerSubject?: Subject | null;
  allowedPrincipals?: Subject[];
  exposure?: InstanceRecord["exposure"];
  status?: InstanceRecord["status"];
} = {}): Pick<
  InstanceRecord,
  "ownerId" | "ownerSubject" | "allowedPrincipals"
> {
  return {
    ownerId: overrides.ownerId ?? 0,
    ownerSubject:
      overrides.ownerSubject !== undefined
        ? overrides.ownerSubject
        : null,
    allowedPrincipals: overrides.allowedPrincipals ?? [],
  };
}

// ── subjectCanAccess ──────────────────────────────────────────────────────

describe("subjectCanAccess", () => {
  describe("public owner", () => {
    it("allows any caller (including null and cross-kind)", async () => {
      const owner: Subject = { kind: "public" };
      expect(await subjectCanAccess(owner, null)).toBe(true);
      expect(
        await subjectCanAccess(owner, { kind: "user", id: "1" }),
      ).toBe(true);
      expect(
        await subjectCanAccess(owner, { kind: "principal", id: "x" }),
      ).toBe(true);
      expect(await subjectCanAccess(owner, { kind: "public" })).toBe(true);
    });
  });

  describe("user owner", () => {
    it("allows the matching user", async () => {
      const owner: Subject = { kind: "user", id: "42" };
      expect(
        await subjectCanAccess(owner, { kind: "user", id: "42" }),
      ).toBe(true);
    });

    it("denies a different user", async () => {
      const owner: Subject = { kind: "user", id: "42" };
      expect(
        await subjectCanAccess(owner, { kind: "user", id: "99" }),
      ).toBe(false);
    });

    // The cross-kind guard is the whole point of the typed-subject
    // model — the legacy `subject_id: String` form allowed
    // `User("alice") == Principal("alice")` because they were both
    // strings. The new model makes the kind tag part of equality.
    it("denies a principal with the same id string (cross-kind guard)", async () => {
      const owner: Subject = { kind: "user", id: "alice" };
      expect(
        await subjectCanAccess(owner, { kind: "principal", id: "alice" }),
      ).toBe(false);
    });

    it("denies a public-kind caller (only public owners are public-readable)", async () => {
      const owner: Subject = { kind: "user", id: "42" };
      expect(await subjectCanAccess(owner, { kind: "public" })).toBe(false);
    });

    it("denies null caller", async () => {
      const owner: Subject = { kind: "user", id: "42" };
      expect(await subjectCanAccess(owner, null)).toBe(false);
    });
  });

  describe("principal owner", () => {
    it("allows the matching principal", async () => {
      const owner: Subject = { kind: "principal", id: "helper" };
      expect(
        await subjectCanAccess(owner, { kind: "principal", id: "helper" }),
      ).toBe(true);
    });

    it("denies a different principal", async () => {
      const owner: Subject = { kind: "principal", id: "helper" };
      expect(
        await subjectCanAccess(owner, { kind: "principal", id: "other" }),
      ).toBe(false);
    });

    it("denies a user caller (even one with the same id string)", async () => {
      const owner: Subject = { kind: "principal", id: "helper" };
      expect(
        await subjectCanAccess(owner, { kind: "user", id: "helper" }),
      ).toBe(false);
    });

    it("denies null caller", async () => {
      const owner: Subject = { kind: "principal", id: "helper" };
      expect(await subjectCanAccess(owner, null)).toBe(false);
    });
  });
});

describe("legacy numeric userId coercion (back-compat shim)", () => {
  it("accepts numeric userId for canAccess", async () => {
    const instance = makeInstance({
      ownerId: 42,
      ownerSubject: { kind: "user", id: "42" },
    });
    expect(await instanceService.canAccess(instance, 42)).toBe(true);
    expect(await instanceService.canAccess(instance, 99)).toBe(false);
  });

  it("accepts numeric userId for isOwner", async () => {
    const instance = makeInstance({
      ownerId: 42,
      ownerSubject: { kind: "user", id: "42" },
    });
    expect(await instanceService.isOwner(instance, 42)).toBe(true);
    expect(await instanceService.isOwner(instance, 99)).toBe(false);
  });
});

// ── resolveOwnerSubject (backfill shim) ──────────────────────────────────

describe("resolveOwnerSubject", () => {
  it("returns the typed owner when present and non-sentinel", () => {
    const instance = makeInstance({
      ownerId: 99, // would resolve to User("99") if backfilled
      ownerSubject: { kind: "principal", id: "helper" },
    });
    expect(resolveOwnerSubject(instance)).toEqual({
      kind: "principal",
      id: "helper",
    });
  });

  it("falls back to legacy ownerId when owner_subject is null", () => {
    const instance = makeInstance({
      ownerId: 42,
      ownerSubject: null,
    });
    expect(resolveOwnerSubject(instance)).toEqual({
      kind: "user",
      id: "42",
    });
  });

  // The runtime migration backfills empty-sentinel
  // `Subject::User("")` on legacy rows. The shim must treat this
  // the same as a null `owner_subject` — fall back to the legacy
  // `ownerId`. Without this, the strict `instance.ownerId !== user.id`
  // check would reject every backfilled instance.
  it("falls back to legacy ownerId when owner_subject is the empty sentinel", () => {
    const instance = makeInstance({
      ownerId: 42,
      ownerSubject: { kind: "user", id: "" },
    });
    expect(resolveOwnerSubject(instance)).toEqual({
      kind: "user",
      id: "42",
    });
  });

  it("returns null when both owner_subject and ownerId are empty", () => {
    const instance = makeInstance({
      ownerId: 0,
      ownerSubject: null,
    });
    expect(resolveOwnerSubject(instance)).toBeNull();
  });

  it("preserves the Public typed owner without falling back", () => {
    expect(
      resolveOwnerSubject(
        makeInstance({
          ownerId: 42,
          ownerSubject: { kind: "public" },
        }),
      ),
    ).toEqual({ kind: "public" });
  });
});

// ── canAccess with the typed allow-list ─────────────────────────────────

describe("canAccess — typed allow-list (allowedPrincipals)", () => {
  it("allows a user caller whose subject is in allowedPrincipals", async () => {
    const instance = makeInstance({
      ownerId: 1,
      ownerSubject: { kind: "user", id: "1" },
      allowedPrincipals: [
        { kind: "user", id: "7" },
        { kind: "principal", id: "helper" },
      ],
    });
    // Owner (1) is allowed
    expect(await instanceService.canAccess(instance, 1)).toBe(true);
    // Allowed user (7)
    expect(await instanceService.canAccess(instance, 7)).toBe(true);
    // Allowed principal
    const caller: CallerSubject = { kind: "principal", id: "helper" };
    expect(await instanceService.canAccess(instance, caller)).toBe(true);
  });

  it("denies a caller that's not in either allow-list", async () => {
    const instance = makeInstance({
      ownerId: 1,
      ownerSubject: { kind: "user", id: "1" },
      allowedPrincipals: [{ kind: "user", id: "7" }],
    });
    expect(await instanceService.canAccess(instance, 99)).toBe(false);
  });
});

// ── ADR-041 acceptance smoke tests ───────────────────────────────────────

describe("ADR-041 acceptance smoke tests", () => {
  it("Principal caller can access Principal-owned instance", async () => {
    const owner: Subject = { kind: "principal", id: "helper" };
    const caller: CallerSubject = { kind: "principal", id: "helper" };
    expect(await subjectCanAccess(owner, caller)).toBe(true);
  });

  it("Principal caller cannot access a different Principal-owned instance", async () => {
    const owner: Subject = { kind: "principal", id: "helper" };
    const caller: CallerSubject = { kind: "principal", id: "other" };
    expect(await subjectCanAccess(owner, caller)).toBe(false);
  });

  it("backfilled User(\"\") sentinel resolves to the legacy User owner", () => {
    // Pre-#11 row that the runtime has now touched — the runtime
    // wrote the empty sentinel to `owner_subject` but the
    // pre-existing `owner_id` is the real legacy owner.
    const instance = makeInstance({
      ownerId: 7,
      ownerSubject: { kind: "user", id: "" },
    });
    const owner = resolveOwnerSubject(instance);
    expect(owner).toEqual({ kind: "user", id: "7" });
    // And the access check matches a User caller with that numeric id.
    expect(
      subjectCanAccess(owner!, { kind: "user", id: "7" }),
    ).resolves.toBe(true);
  });
});
