import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// Subject — canonical actor type (ADR-041, supersedes ADR-039)
//
// ADR-039 introduced a unified `Principal` enum (User | Agent | Team |
// Public) to replace the three partial models that previously existed
// (`Peer::{User, Agent}`, `SubjectType::{User, Team, Public}`, and
// `AgentConfig::owner_id: String`). PekoHub adopted the enum and
// served it as the wire format for principal ownership /
// permission grants.
//
// ADR-041 elevates `Principal` to a top-level runtime entity
// (the "principal-as-container" model). To avoid terminology
// collision between the actor enum and the runtime entity, the actor
// enum is renamed to `Subject`. The `Agent` variant is renamed to
// `Principal` (the actor enum has User/Principal/Public; Team was
// removed in the ADR-041 clean break).
//
// Wire format: `{ "kind": "user|principal|public", "id": "..." }` for
// the two with an id; `{ "kind": "public" }` for Public. This matches
// the runtime's `#[serde(tag = "kind", content = "id")]` derive on
// `peko-runtime/src/subject.rs`.
// ─────────────────────────────────────────────────────────────────────────────

export const SubjectKinds = ['user', 'principal', 'public'] as const;
export type SubjectKind = (typeof SubjectKinds)[number];

export const Subject = z.discriminatedUnion('kind', [
  // `id: z.string()` (no `.min(1)`) so the empty-sentinel
  // `{ kind: 'user', id: '' }` is schema-valid. The empty check is
  // gated at `isEmptyOwnerSubject` so it doesn't leak into every
  // schema that embeds `Subject`. The runtime migration writes
  // this exact shape (see
  // `peko-runtime/src/runtime/migration.rs:170-171, 234-235`) so the
  // schema must accept it.
  z.object({ kind: z.literal('user'), id: z.string() }),
  z.object({ kind: z.literal('principal'), id: z.string() }),
  z.object({ kind: z.literal('public') }),
]);
export type Subject = z.infer<typeof Subject>;

// ── Constants for empty-sentinel detection ──────────────────────────────────

/**
 * The legacy "no owner asserted" sentinel. Set by
 * `peko-runtime/src/runtime/migration.rs:170-171, 234-235` when
 * backfilling legacy instances that never had an `owner` block.
 * PekoHub treats this as "use the legacy `ownerId` column
 * instead" — see `resolveOwnerSubject` in the instances service.
 *
 * Schema-valid now that the Zod discriminated union allows empty
 * ids. The semantic check is gated at `isEmptyOwnerSubject`.
 */
export const EMPTY_OWNER_SUBJECT: Subject = { kind: 'user', id: '' };

/** True for any `Subject::User("")`-shaped empty sentinel. */
export function isEmptyOwnerSubject(p: Subject | null | undefined): boolean {
  return !!p && p.kind === 'user' && p.id === '';
}

// ── Parse / serialize ──────────────────────────────────────────────────────

/**
 * Parse a `Subject` from its `Display` format
 * (`"user:alice" | "principal:helper" | "public"`).
 *
 * Inverse of `subjectToString`. Round-trips are byte-stable.
 *
 * An empty string is treated as the `EMPTY_OWNER_SUBJECT`
 * sentinel (rather than an error) so legacy `owner_id = ""`
 * values don't break parsing — they just get the sentinel form
 * that the backfill shim recognises.
 */
export function parseSubject(s: string | null | undefined): Subject | null {
  if (s === null || s === undefined) return null;
  if (s === '') return EMPTY_OWNER_SUBJECT;
  if (s === 'public') return { kind: 'public' };
  const idx = s.indexOf(':');
  if (idx < 0) return null;
  const kind = s.slice(0, idx);
  const id = s.slice(idx + 1);
  if (!SubjectKinds.includes(kind as SubjectKind)) return null;
  if (kind === 'public') return { kind: 'public' };
  if (id === '') return null;
  return { kind: kind as SubjectKind, id } as Subject;
}

/**
 * Serialize a `Subject` to its `Display` format. Inverse of
 * `parseSubject`. Always round-trips back to the same value.
 */
export function subjectToString(p: Subject): string {
  if (p.kind === 'public') return 'public';
  return `${p.kind}:${p.id}`;
}

/**
 * Opaque, comparable subject identifier (the "id" component, or
 * `"public"` for the unauthenticated case). Mirrors
 * `Subject::subject_id()` in peko-runtime.
 */
export function subjectId(p: Subject): string {
  return p.kind === 'public' ? 'public' : p.id;
}

/**
 * True for any subject that carries a per-session identity.
 * Mirrors `Subject::is_session_peer()` in peko-runtime. Only
 * `User` and `Principal` carry such an identity; `Public` does
 * not. The runtime has no `Team` variant in the Subject enum
 * (ADR-041).
 */
export function isSessionPeer(p: Subject): boolean {
  return p.kind === 'user' || p.kind === 'principal';
}

// ── Defensive parsers for legacy wire data ─────────────────────────────────

/**
 * Build a `Subject` from a wire-format string with a fallback kind.
 *
 * Mirrors `subject_from_string` in peko-runtime. Tries
 * `parseSubject` first; on failure, treats the string as an id of
 * the supplied kind. An empty string always resolves to
 * `EMPTY_OWNER_SUBJECT` (legacy "no owner" sentinel).
 */
export function subjectFromString(
  s: string,
  defaultKind: Exclude<SubjectKind, 'public'>,
): Subject {
  if (s === '') return EMPTY_OWNER_SUBJECT;
  const parsed = parseSubject(s);
  if (parsed) return parsed;
  return { kind: defaultKind, id: s };
}
