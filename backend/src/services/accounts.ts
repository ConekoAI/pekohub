import { and, eq, isNotNull, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { bundles, instances, users } from "../db/schema.js";

/**
 * Accounts made at first sign-in (GitHub, Google).
 *
 * A handle is the account's ID (`@alice`, hub ADR-009): lowercase letters,
 * digits, `-` and `_`, starting with a letter or digit — what `parseHubRef`
 * and the directory routes accept. The provider's name for the person is
 * only a suggestion: a GitHub login keeps its letters but not its case, a
 * Google name gives its words joined by `-` (never the email address, which
 * a public handle would give away), and a handle someone else holds, or
 * one the site keeps for itself, gets a number (`alice-2`).
 *
 * The person confirms it, or picks another, on the website after first
 * sign-in (`chooseHandle`). A handle can change until something is
 * published under it: a seed's ID (`alice/ada`) and a public peko's share
 * link (`@alice/ada`) carry it, and those are handed around.
 */

export const HANDLE_MIN = 2;
export const HANDLE_MAX = 39;
const MAX_ATTEMPTS = 20;

/** Lowercase letters, digits, `-` and `_`; begins and ends with a letter or digit. */
const HANDLE_FORMAT = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;

/**
 * Handles no one gets: the website's own paths (a seed's page is
 * `/:owner/:name`, so a handle `auth` would shadow `/auth/callback`),
 * words that read as the site speaking, and the fallback `user`.
 */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  // Website and API paths.
  "about", "admin", "api", "assets", "auth", "authorize", "bundles",
  "callback", "dashboard", "device", "discover", "docs", "download",
  "downloads", "g", "login", "logout", "new", "oauth", "p", "peko",
  "pekos", "people", "privacy", "profile", "search", "seeds", "settings",
  "signin", "signout", "signup", "static", "status", "templates", "terms",
  "v1", "v2", "welcome", "well-known", "www",
  // The site, its staff and its systems.
  "abuse", "account", "accounts", "billing", "blog", "contact", "help",
  "hub", "mod", "moderator", "moderators", "official", "pekohub", "root",
  "security", "staff", "support", "system", "team",
  // Placeholders.
  "anonymous", "everyone", "me", "null", "nobody", "undefined", "user",
  "users", "visitor",
]);

export type HandleProblem = "invalid" | "reserved";

/** Why `handle` can't be anyone's, or null when it can. */
export function handleProblem(handle: string): HandleProblem | null {
  if (
    handle.length < HANDLE_MIN ||
    handle.length > HANDLE_MAX ||
    !HANDLE_FORMAT.test(handle)
  ) {
    return "invalid";
  }
  return RESERVED_HANDLES.has(handle) ? "reserved" : null;
}

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
    if (handleProblem(namespace)) continue;
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

/**
 * What keeps an account's handle fixed: a seed published under it, or a
 * public peko whose share link carries it. Null while it can still change.
 */
export async function handleLock(
  userId: string,
  namespace: string,
): Promise<"seeds" | "public_peko" | null> {
  const seed = await db.query.bundles.findFirst({
    where: or(eq(bundles.publisherId, userId), eq(bundles.namespace, namespace)),
    columns: { id: true },
  });
  if (seed) return "seeds";
  const [peko] = await db
    .select({ id: instances.id })
    .from(instances)
    .where(
      and(
        sql`${instances.ownerSubject}->>'kind' = 'user'`,
        sql`${instances.ownerSubject}->>'id' = ${userId}`,
        or(eq(instances.exposure, "public"), isNotNull(instances.publishedAt)),
      ),
    )
    .limit(1);
  return peko ? "public_peko" : null;
}

export type HandleAvailability =
  | { available: true }
  | { available: false; reason: HandleProblem | "taken" };

/** Whether `userId` could take `handle` (their own handle is available to them). */
export async function handleAvailability(
  userId: string,
  handle: string,
): Promise<HandleAvailability> {
  const problem = handleProblem(handle);
  if (problem) return { available: false, reason: problem };
  const holder = await db.query.users.findFirst({
    where: eq(users.namespace, handle),
    columns: { id: true },
  });
  return !holder || holder.id === userId
    ? { available: true }
    : { available: false, reason: "taken" };
}

export type ChooseHandleResult =
  | { ok: true; user: typeof users.$inferSelect }
  | { ok: false; reason: HandleProblem | "taken" | "locked" };

/**
 * Confirm the account's handle, or change it while nothing is published
 * under it. Keeping the current handle always succeeds.
 */
export async function chooseHandle(
  userId: string,
  requested: string,
): Promise<ChooseHandleResult> {
  const handle = requested.trim().replace(/^@/, "").toLowerCase();
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw new Error(`No account ${userId}`);

  const now = new Date();
  if (handle === user.namespace) {
    const [kept] = await db
      .update(users)
      .set({ handleChosenAt: user.handleChosenAt ?? now })
      .where(eq(users.id, userId))
      .returning();
    return { ok: true, user: kept };
  }

  const problem = handleProblem(handle);
  if (problem) return { ok: false, reason: problem };
  if (await handleLock(user.id, user.namespace)) return { ok: false, reason: "locked" };

  try {
    const [renamed] = await db
      .update(users)
      .set({ namespace: handle, handleChosenAt: now, updatedAt: now })
      .where(eq(users.id, userId))
      .returning();
    return { ok: true, user: renamed };
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, reason: "taken" };
    throw error;
  }
}
