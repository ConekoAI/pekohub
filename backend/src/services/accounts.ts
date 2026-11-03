import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";

/**
 * Accounts made at first sign-in (GitHub, Google).
 *
 * A handle is the account's ID (`@alice`, hub ADR-009): lowercase letters,
 * digits, `-` and `_`, starting with a letter or digit — what `parseHubRef`
 * and the directory routes accept. The provider's name for the person is
 * only a suggestion: a GitHub login keeps its letters but not its case, a
 * Google address gives the part before the `@`, and a handle someone else
 * holds gets a number (`alice-2`).
 */

const HANDLE_MAX = 39;
const MAX_ATTEMPTS = 20;

/** A valid handle from a provider's username or email local part. */
export function handleFromName(raw: string): string {
  const handle = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, HANDLE_MAX)
    .replace(/[-_]+$/, "");
  return handle || "user";
}

/** `base`, then `base-2`, `base-3`, … within the length limit. */
export function handleCandidate(base: string, attempt: number): string {
  if (attempt === 1) return base;
  const suffix = `-${attempt}`;
  return `${base.slice(0, HANDLE_MAX - suffix.length)}${suffix}`;
}

export interface ProviderProfile {
  /** `github:<id>` / `google:<sub>`: stable across renames. */
  externalId: string;
  provider: string;
  /** The provider's username or email local part. */
  suggestedHandle: string;
  displayName: string;
  email?: string;
  avatarUrl?: string;
}

function isUniqueViolation(error: unknown): boolean {
  const code =
    (error as { code?: string } | null)?.code ??
    (error as { cause?: { code?: string } } | null)?.cause?.code;
  return code === "23505";
}

/** The account for this provider identity, made with a free handle on first sign-in. */
export async function findOrCreateUser(profile: ProviderProfile) {
  const existing = await db.query.users.findFirst({
    where: eq(users.externalId, profile.externalId),
  });
  if (existing) return existing;

  const base = handleFromName(profile.suggestedHandle);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const namespace = handleCandidate(base, attempt);
    const taken = await db.query.users.findFirst({ where: eq(users.namespace, namespace) });
    if (taken) continue;
    try {
      const [inserted] = await db
        .insert(users)
        .values({
          externalId: profile.externalId,
          provider: profile.provider,
          namespace,
          displayName: profile.displayName,
          email: profile.email,
          avatarUrl: profile.avatarUrl,
        })
        .returning();
      return inserted;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // A concurrent sign-in took this handle, or made this very account.
      const raced = await db.query.users.findFirst({
        where: eq(users.externalId, profile.externalId),
      });
      if (raced) return raced;
    }
  }
  throw new Error(`No free handle near @${base}`);
}
