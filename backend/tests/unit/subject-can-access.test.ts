/**
 * Unit tests for ADR-041's `subjectCanAccess` helper and the
 * `resolveOwnerSubject` resolver.
 *
 * Pure functions — no DB, no Fastify. Mirrors the peko-runtime
 * ADR-039 back-compat test pattern (`auth::ownership::tests` in
 * `peko-runtime/src/auth/ownership.rs`).
 *
 * ADR-041 removed the `Team` subject variant, so there is no
 * "team owner" describe block — all access is `User` / `Principal`
 * / `Public`.
 *
 * Post-H1 the legacy `owner_id` integer FK is gone; the typed
 * `owner_subject` JSONB column is the only source of truth. The
 * legacy "fall back to `owner_id`" tests in this file are gone
 * with it — see the comment on `resolveOwnerSubject` in
 * `services/instances.ts`.
 */

import { describe, it, expect } from "vitest";
import type { Subject } from "@pekohub/shared";
import {
  subjectCanAccess,
  resolveOwnerSubject,
  type CallerSubject,
  type InstanceRecord,
} from "../../src/services/instances.js";

// Minimal InstanceRecord stub — only the fields the helpers actually
// read. The `type: "principal"` literal matches the post-ADR-041
// schema.
//
// Post-H4: the `allowedPrincipals` field is gone from the record.
// The runtime owns the ACL surface (R4); pekohub only knows about
// the typed owner + exposure switch.
function makeInstance(overrides: {
  ownerSubject?: Subject | null;
  exposure?: InstanceRecord["exposure"];
  status?: InstanceRecord["status"];
} = {}): Pick<InstanceRecord, "ownerSubject"> {
  return {
    ownerSubject:
      overrides.ownerSubject !== undefined
        ? overrides.ownerSubject
        : null,
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

// ── resolveOwnerSubject (post-H1) ───────────────────────────────────────

describe("resolveOwnerSubject", () => {
  it("returns the typed owner when present and non-sentinel", () => {
    const instance = makeInstance({
      ownerSubject: { kind: "principal", id: "helper" },
    });
    expect(resolveOwnerSubject(instance)).toEqual({
      kind: "principal",
      id: "helper",
    });
  });

  it("returns null when owner_subject is null", () => {
    const instance = makeInstance({
      ownerSubject: null,
    });
    expect(resolveOwnerSubject(instance)).toBeNull();
  });

  // The runtime migration backfills empty-sentinel
  // `Subject::User("")` on legacy rows. The resolver must treat this
  // as "no owner asserted" (post-H1 there is nothing to fall back to)
  // so that downstream access checks correctly drop the row.
  it("returns null when owner_subject is the empty sentinel", () => {
    const instance = makeInstance({
      ownerSubject: { kind: "user", id: "" },
    });
    expect(resolveOwnerSubject(instance)).toBeNull();
  });

  it("preserves the Public typed owner without falling back", () => {
    expect(
      resolveOwnerSubject(
        makeInstance({
          ownerSubject: { kind: "public" },
        }),
      ),
    ).toEqual({ kind: "public" });
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
});