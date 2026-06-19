import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// Principal — canonical actor type (mirrors ADR-039 / peko-runtime's Principal)
//
// The runtime introduced a unified `Principal` enum (User | Agent | Team |
// Public) to replace the three partial models it had previously
// (`Peer::{User, Agent}`, `SubjectType::{User, Team, Public}`, and
// `AgentConfig::owner_id: String`). PekoHub is the downstream consumer: it
// must accept any of these as the *owner* of an instance, and (for chat
// proxy) as the *caller* of an instance.
//
// Wire format: `{ "kind": "user|agent|team|public", "id": "..." }` for the
// three with an id; `{ "kind": "public" }` for Public. This matches the
// runtime's `#[serde(tag = "kind", content = "id")]` derive on
// `peko-runtime/src/auth/principal.rs`.
// ─────────────────────────────────────────────────────────────────────────────

export const PrincipalKinds = ['user', 'agent', 'team', 'public'] as const;
export type PrincipalKind = (typeof PrincipalKinds)[number];

export const Principal = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), id: z.string().min(1) }),
  z.object({ kind: z.literal('agent'), id: z.string().min(1) }),
  z.object({ kind: z.literal('team'), id: z.string().min(1) }),
  z.object({ kind: z.literal('public') }),
]);
export type Principal = z.infer<typeof Principal>;

// ── Constants for empty-sentinel detection ──────────────────────────────────

/**
 * The legacy "no owner asserted" sentinel. Set by
 * `peko-runtime/src/runtime/migration.rs:170-171, 234-235` when backfilling
 * legacy instances that never had an `owner` block. PekoHub treats this
 * as "use the legacy `ownerId` column instead" — see
 * `resolveOwnerPrincipal` in the instances service.
 */
export const EMPTY_OWNER_PRINCIPAL: Principal = { kind: 'user', id: '' };

/** True for any `Principal::User("")`-shaped empty sentinel. */
export function isEmptyOwnerPrincipal(p: Principal | null | undefined): boolean {
  return !!p && p.kind === 'user' && p.id === '';
}

// ── Parse / serialize ──────────────────────────────────────────────────────

/**
 * Parse a `Principal` from its `Display` format
 * (`"user:alice" | "agent:helper" | "team:eng" | "public"`).
 *
 * Inverse of `principalToString`. Round-trips are byte-stable.
 *
 * An empty string is treated as the `EMPTY_OWNER_PRINCIPAL` sentinel
 * (rather than an error) so legacy `owner_id = ""` values don't break
 * parsing — they just get the sentinel form that the backfill shim
 * recognises.
 */
export function parsePrincipal(s: string | null | undefined): Principal | null {
  if (s === null || s === undefined) return null;
  if (s === '') return EMPTY_OWNER_PRINCIPAL;
  if (s === 'public') return { kind: 'public' };
  const idx = s.indexOf(':');
  if (idx < 0) return null;
  const kind = s.slice(0, idx);
  const id = s.slice(idx + 1);
  if (!PrincipalKinds.includes(kind as PrincipalKind)) return null;
  if (kind === 'public') return { kind: 'public' };
  if (id === '') return null;
  return { kind: kind as PrincipalKind, id } as Principal;
}

/**
 * Serialize a `Principal` to its `Display` format. Inverse of
 * `parsePrincipal`. Always round-trips back to the same value.
 */
export function principalToString(p: Principal): string {
  if (p.kind === 'public') return 'public';
  return `${p.kind}:${p.id}`;
}

/**
 * Opaque, comparable subject identifier (the "id" component, or
 * `"public"` for the unauthenticated case). Mirrors
 * `Principal::subject_id()` in peko-runtime.
 */
export function principalSubjectId(p: Principal): string {
  return p.kind === 'public' ? 'public' : p.id;
}

/**
 * True if this principal can be used as a session peer. Mirrors
 * `Principal::is_session_peer()`. Only `User` and `Agent` carry a
 * per-session identity; `Team` resolves to a set of members at check
 * time, and `Public` has no identity.
 */
export function isSessionPeer(p: Principal): boolean {
  return p.kind === 'user' || p.kind === 'agent';
}

// ── Defensive parsers for legacy wire data ─────────────────────────────────

/**
 * Build a `Principal` from a wire-format string with a fallback kind.
 *
 * Mirrors `principal_from_string` in peko-runtime. Tries
 * `parsePrincipal` first; on failure, treats the string as an id of
 * the supplied kind. An empty string always resolves to
 * `EMPTY_OWNER_PRINCIPAL` (legacy "no owner" sentinel).
 */
export function principalFromString(
  s: string,
  defaultKind: Exclude<PrincipalKind, 'public'>
): Principal {
  if (s === '') return EMPTY_OWNER_PRINCIPAL;
  const parsed = parsePrincipal(s);
  if (parsed) return parsed;
  return { kind: defaultKind, id: s };
}
