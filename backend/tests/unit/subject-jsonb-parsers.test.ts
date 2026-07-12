/**
 * Unit tests for the JSONB defensive parsers added in review #12 P1
 * (`parseSubjectJsonb` and `parseSubjectArrayJsonb`).
 *
 * Review concern: the Drizzle `$type<Principal | null>()` cast on the
 * `owner_subject` and `allowed_principals` columns is compile-time
 * only. A malformed JSONB value (e.g. `{"kind": "user", "id": null}`
 * from a future migration bug, a manual psql edit, or a backfill
 * that goes wrong) would otherwise flow straight into
 * `subjectCanAccess` — where `null === null` would silently grant
 * access. These parsers are the fix; the tests are the proof.
 */

import { describe, it, expect } from "vitest";
import type { Principal } from "@pekohub/shared";
import {
  parseSubjectJsonb,
  parseSubjectArrayJsonb,
} from "../../src/services/instances.js";

describe("parseSubjectJsonb (review #12 P1)", () => {
  describe("null / missing / undefined", () => {
    it("returns null for null", () => {
      expect(parseSubjectJsonb(null)).toBeNull();
    });

    it("returns null for undefined", () => {
      expect(parseSubjectJsonb(undefined)).toBeNull();
    });
  });

  describe("well-formed inputs", () => {
    it("accepts a User principal", () => {
      const raw: unknown = { kind: "user", id: "42" };
      expect(parseSubjectJsonb(raw)).toEqual({ kind: "user", id: "42" });
    });

    it("accepts a Principal subject", () => {
      const raw: unknown = { kind: "principal", id: "helper" };
      expect(parseSubjectJsonb(raw)).toEqual({
        kind: "principal",
        id: "helper",
      });
    });

    it("accepts a Public principal (no id field)", () => {
      const raw: unknown = { kind: "public" };
      expect(parseSubjectJsonb(raw)).toEqual({ kind: "public" });
    });

    // The empty sentinel `Principal::User("")` MUST round-trip
    // through the schema so the backfill shim recognises it.
    it("accepts the empty-sentinel User(\"\")", () => {
      const raw: unknown = { kind: "user", id: "" };
      expect(parseSubjectJsonb(raw)).toEqual({ kind: "user", id: "" });
    });
  });

  describe("malformed inputs — the review #12 attack vectors", () => {
    it("rejects {kind: 'user', id: null} (the null === null attack)", () => {
      // Without the validator, this would have flowed into
      // subjectCanAccess as Principal::User(null), and
      // `null === null` would have matched any caller. The fix
      // drops the malformed row to `null` so the backfill shim
      // falls back to the legacy `ownerId` (or null).
      const raw: unknown = { kind: "user", id: null };
      expect(parseSubjectJsonb(raw)).toBeNull();
    });

    it("rejects {kind: 'user'} (missing id)", () => {
      const raw: unknown = { kind: "user" };
      expect(parseSubjectJsonb(raw)).toBeNull();
    });

    it("rejects an unknown kind", () => {
      const raw: unknown = { kind: "admin", id: "root" };
      expect(parseSubjectJsonb(raw)).toBeNull();
    });

    it("rejects a non-object primitive", () => {
      expect(parseSubjectJsonb("user:42")).toBeNull();
      expect(parseSubjectJsonb(42)).toBeNull();
      expect(parseSubjectJsonb(true)).toBeNull();
      expect(parseSubjectJsonb([])).toBeNull();
    });

    it("rejects a deeply-nested extra-fields object (defence in depth)", () => {
      const raw: unknown = { kind: "user", id: "42", extra: "evil" };
      // Zod's `.object({...})` is strip-by-default — extra fields
      // don't fail validation, but the parsed result shouldn't leak
      // the extra. We just verify the principal is well-formed.
      const parsed = parseSubjectJsonb(raw);
      expect(parsed).toEqual({ kind: "user", id: "42" });
    });
  });
});

describe("parseSubjectArrayJsonb (review #12 P1)", () => {
  it("returns [] for null", () => {
    expect(parseSubjectArrayJsonb(null)).toEqual([]);
  });

  it("returns [] for a non-array value", () => {
    expect(parseSubjectArrayJsonb("not an array")).toEqual([]);
    expect(parseSubjectArrayJsonb({ kind: "user", id: "1" })).toEqual([]);
    expect(parseSubjectArrayJsonb(42)).toEqual([]);
  });

  it("accepts an array of well-formed principals", () => {
    const raw: unknown = [
      { kind: "user", id: "1" },
      { kind: "principal", id: "helper" },
      { kind: "public" },
    ];
    expect(parseSubjectArrayJsonb(raw)).toEqual([
      { kind: "user", id: "1" },
      { kind: "principal", id: "helper" },
      { kind: "public" },
    ]);
  });

  // The review concern: a single malformed entry in the
  // `allowed_principals` array could let an attacker sneak a
  // shape like `null` into the list, where `null === null` would
  // match any caller. The fix is to filter malformed entries.
  it("filters out malformed entries (the null === null attack vector)", () => {
    const raw: unknown = [
      { kind: "user", id: "1" },
      { kind: "user", id: null }, // malicious
      { kind: "principal", id: "helper" },
      "not a subject", // garbage
      null, // garbage
      { kind: "user" }, // missing id
      { kind: "team", id: "eng" }, // Team variant removed in ADR-041 — silently filtered
    ];
    const parsed = parseSubjectArrayJsonb(raw);
    expect(parsed).toEqual([
      { kind: "user", id: "1" },
      { kind: "principal", id: "helper" },
    ]);
  });

  it("preserves the empty-sentinel User(\"\") in the allow-list", () => {
    const raw: unknown = [{ kind: "user", id: "" }];
    expect(parseSubjectArrayJsonb(raw)).toEqual([{ kind: "user", id: "" }]);
  });
});

// ── End-to-end: validate → resolve → canAccess ────────────────────────────

import { instanceService } from "../../src/services/instances.js";

describe("toRecord → resolveOwnerPrincipal pipeline (review #12 P1)", () => {
  it("a malformed owner row falls back to the legacy ownerId", async () => {
    // The validation pipeline would feed a malformed row through
    // parseSubjectJsonb first; the result is null. resolveOwnerPrincipal
    // then falls back to the legacy `ownerId` column.
    const validated = parseSubjectJsonb({ kind: "user", id: null });
    expect(validated).toBeNull();

    const instance = {
      ownerId: 7,
      ownerSubject: validated, // null after validation
      allowedPrincipals: [],
      allowedPrincipals: [],
    };
    // Legacy user 7 should still be able to access the instance.
    expect(await instanceService.canAccess(instance, 7)).toBe(true);
  });

  it("a malformed allow-list entry doesn't grant a null === null match", async () => {
    // Pre-validation: an attacker has injected {kind: 'user', id: null}
    // into the allow-list. Post-validation: the entry is filtered out.
    const validated = parseSubjectArrayJsonb([
      { kind: "user", id: null },
    ]);
    expect(validated).toEqual([]);

    // A user whose id is literally the string "null" should NOT match
    // (because the malformed entry is gone, not because of any
    // false-positive match).
    const instance = {
      ownerId: 1,
      ownerSubject: { kind: "user" as const, id: "1" } as Principal,
      allowedPrincipals: [],
      allowedPrincipals: validated,
    };
    expect(await instanceService.canAccess(instance, 1)).toBe(true); // owner
    expect(await instanceService.canAccess(instance, 99)).toBe(false);
  });
});
