/**
 * Unit tests for the JSONB defensive parsers added in review #12 P1
 * (`parseSubjectJsonb` and `parseSubjectArrayJsonb`).
 *
 * Review concern: the Drizzle `$type<Subject | null>()` cast on the
 * `owner_subject` column is compile-time only. A malformed JSONB
 * value (e.g. `{"kind": "user", "id": null}` from a future migration
 * bug, a manual psql edit, or a backfill that goes wrong) would
 * otherwise flow straight into `subjectCanAccess` — where
 * `null === null` would silently grant access. These parsers are
 * the fix; the tests are the proof.
 *
 * Post-H1: the legacy `owner_id` integer FK is gone, so a malformed
 * `owner_subject` no longer has a column to fall back to. The
 * resolver treats a null `owner_subject` as "ownerless row" — see
 * `resolveOwnerSubject` in `services/instances.ts`.
 *
 * Post-H4: the `allowed_principals` column is gone from the
 * `instances` table entirely. The `parseSubjectArrayJsonb` parser
 * stays (re-used by other surfaces) but the per-row allowedPrincipals
 * end-to-end tests are gone with it.
 */

import { describe, it, expect } from "vitest";
import type { Subject } from "@pekohub/shared";
import {
  parseSubjectJsonb,
  parseSubjectArrayJsonb,
  instanceService,
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
    it("accepts a User subject", () => {
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

    it("accepts a Public subject (no id field)", () => {
      const raw: unknown = { kind: "public" };
      expect(parseSubjectJsonb(raw)).toEqual({ kind: "public" });
    });

    // The empty sentinel `Subject::User("")` MUST round-trip
    // through the schema so the resolver recognises it as
    // "no owner asserted" (post-H1 it has nothing to fall back to).
    it("accepts the empty-sentinel User(\"\")", () => {
      const raw: unknown = { kind: "user", id: "" };
      expect(parseSubjectJsonb(raw)).toEqual({ kind: "user", id: "" });
    });
  });

  describe("malformed inputs — the review #12 attack vectors", () => {
    it("rejects {kind: 'user', id: null} (the null === null attack)", () => {
      // Without the validator, this would have flowed into
      // subjectCanAccess as Subject::User(null), and
      // `null === null` would have matched any caller. The fix
      // drops the malformed row to `null` so the resolver
      // sees an ownerless row (post-H1; pre-H1 it would
      // have fallen back to the legacy `ownerId`).
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
      // the extra. We just verify the subject is well-formed.
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

  it("accepts an array of well-formed subjects", () => {
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

  // The review concern: a single malformed entry in a subject
  // array could let an attacker sneak a shape like `null` into
  // the list, where `null === null` would match any caller. The
  // fix is to filter malformed entries.
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

  it("preserves the empty-sentinel User(\"\") in the array", () => {
    const raw: unknown = [{ kind: "user", id: "" }];
    expect(parseSubjectArrayJsonb(raw)).toEqual([{ kind: "user", id: "" }]);
  });
});

// ── End-to-end: validate → resolve → canAccess ────────────────────────────

describe("toRecord → resolveOwnerSubject pipeline (review #12 P1)", () => {
  it("a malformed owner row makes the instance ownerless (post-H1)", async () => {
    // The validation pipeline feeds a malformed row through
    // parseSubjectJsonb first; the result is null. Post-H1 the
    // resolver returns null when `owner_subject` is null — there's
    // no legacy `owner_id` to fall back to (the column was dropped
    // in migration 0010). The access check then denies everyone.
    const validated = parseSubjectJsonb({ kind: "user", id: null });
    expect(validated).toBeNull();

    const instance = {
      ownerSubject: validated, // null after validation
    };
    // Even the (hypothetical) legacy owner can no longer access —
    // the row is ownerless and would be invisible to the caller.
    expect(await instanceService.canAccess(instance, "7")).toBe(false);
    expect(await instanceService.canAccess(instance, "99")).toBe(false);
  });
});