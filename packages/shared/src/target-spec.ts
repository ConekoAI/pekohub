import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// TargetSpec — the cross-runtime address the runtime hands PekoHub to
// resolve into a host.
//
// Two flavours:
//   * RemoteByDID — a principal DID. Since peko-runtime ADR-058 D1 the
//     principal DID is a self-certifying `did:key` of the principal's
//     ed25519 identity key; legacy `did:peko:public:*` DIDs still exist
//     in the wild and are treated as *unverified* (no PoP possible).
//     Resolution is a single indexed DB lookup.
//   * RemoteByHandle — `{ owner_namespace, principal_name }`. The
//     human-readable form. Resolves to the same payload but joins
//     through `users.namespace`.
//
// Both come from a wire format. The default parse is a URL-style path
// segment: `<did>` or `<owner_namespace>/<principal_name>`. Parsing is
// permissive on the DID shape (just non-empty) so future DID method
// additions don't break the resolver; the authoritative validation
// lives in the storage layer (`instances.principal_did` unique index)
// and the runtime-side signer.
//
// Naming note (peko-runtime ADR-059): wire/machine names keep the
// `principal` vocabulary (`principalName`, `principal_did`); "peko"
// is the user-facing term only.
// ─────────────────────────────────────────────────────────────────────────────

export const TargetSpecKind = ['by-did', 'by-handle'] as const;
export type TargetSpecKind = (typeof TargetSpecKind)[number];

const PrincipalDID = z
  .string()
  .min(1)
  .max(512)
  .describe('A principal DID — `did:key:z6Mk…` post ADR-058 (legacy `did:peko:*` tolerated, unverified).');

const Namespace = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'Invalid namespace')
  .describe('Owner namespace (User-kind; the runtime no longer has a Team-kind principal).');

// Mirrors peko-runtime's `validate_agent_name`
// (peko-runtime/peko-rs/core/src/common/identifiers.rs:49-76):
//   - 1-64 chars
//   - ASCII alphanumeric, "-", or "_"
//   - no leading/trailing "-"
//   - no ".." segment (path-traversal defense, runtime PR #241)
//
// The regex anchors the first char as alnum and the character class
// to the alnum/`-`/`_` set. The leading/trailing "-" rule and the
// ".." rule are enforced as explicit `.refine`s so the intent is
// obvious and survives a future regex loosening. Without the
// trailing-`-` refine, `trailing-` would match the regex.
export const PrincipalName = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/,
    'Principal name must be 1-64 chars: ASCII alnum, "-", or "_"; no leading/trailing "-" or "."',
  )
  .refine((s) => !s.startsWith('-') && !s.endsWith('-'), {
    message: 'Principal name must not start or end with "-"',
  })
  .refine((s) => s !== '..' && s !== '.' && !s.includes('..'), {
    message: 'Principal name must not contain ".."',
  })
  .describe('The runtime-side principal name (== `instances.name`).');

export const RemoteByDID = z.object({
  kind: z.literal('by-did'),
  did: PrincipalDID,
  /** Optional runtime-id hint to short-circuit the lookup. */
  runtimeIdHint: z.string().min(1).max(255).optional(),
});
export type RemoteByDID = z.infer<typeof RemoteByDID>;

export const RemoteByHandle = z.object({
  kind: z.literal('by-handle'),
  owner: Namespace,
  principalName: PrincipalName,
});
export type RemoteByHandle = z.infer<typeof RemoteByHandle>;

export const TargetSpec = z.discriminatedUnion('kind', [
  RemoteByDID,
  RemoteByHandle,
]);
export type TargetSpec = z.infer<typeof TargetSpec>;

// ── Wire format (path segment) ──────────────────────────────────────────────

/**
 * Encode a `TargetSpec` to a stable, URL-safe path segment. Inverse of
 * `parseTargetSpecPath`.
 *
 *   by-did:    `<did>`                              (e.g. `did:key:z6Mk…`)
 *   by-handle: `<owner>/<principal_name>`           (e.g. `alice/helper`)
 *
 * The leading `kind` tag is omitted — the by-did branch is identifiable
 * by the `did:` prefix, and by-handle is the catch-all. If a future
 * addition is ambiguous with a DID prefix, revisit.
 */
export function formatTargetSpecPath(spec: TargetSpec): string {
  if (spec.kind === 'by-did') return spec.did;
  return `${spec.owner}/${spec.principalName}`;
}

/**
 * Parse a path segment back into a `TargetSpec`. The only required
 * disambiguation is the `did:` prefix; everything else is treated as
 * a by-handle spec split on the first `/`.
 *
 * Returns `null` on bad input. Callers (route handlers) convert that
 * to 400.
 */
export function parseTargetSpecPath(s: string): TargetSpec | null {
  if (s === '') return null;
  if (s.startsWith('did:')) {
    const parsed = RemoteByDID.safeParse({ kind: 'by-did', did: s });
    return parsed.success ? parsed.data : null;
  }
  const idx = s.indexOf('/');
  if (idx < 0) return null;
  const owner = s.slice(0, idx);
  const principalName = s.slice(idx + 1);
  if (owner === '' || principalName === '') return null;
  const parsed = RemoteByHandle.safeParse({
    kind: 'by-handle',
    owner,
    principalName,
  });
  return parsed.success ? parsed.data : null;
}
