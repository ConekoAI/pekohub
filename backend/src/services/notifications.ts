import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { notifications } from "../db/schema.js";
import { reportError } from "./error-reporting.js";

/**
 * Notifications: what an account should hear about, without email. The
 * website's bell and Peko desktop read them (`GET /v1/me/notifications`).
 *
 * `notify` never fails or delays the request that triggers it: a lost
 * notification is logged, the action it reports stands.
 */

export type NotificationKind =
  | "transfer.offered"
  | "transfer.accepted"
  | "transfer.declined"
  | "transfer.withdrawn"
  | "security.runtime_registered"
  | "security.api_key_created"
  | "security.sign_in"
  | "moderation.seed_hidden"
  | "moderation.seed_shown"
  | "moderation.seed_version_yanked"
  | "moderation.seed_version_restored"
  | "moderation.peko_taken_down"
  | "moderation.peko_restored"
  | "moderation.report_resolved";

/** Website pages notifications point at. */
export const PAGES = {
  pekos: "/dashboard",
  seeds: "/dashboard/seeds",
  runtimes: "/dashboard/runtimes",
  account: "/profile",
} as const;

/** How long a notification is kept. */
export const NOTIFICATION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** Newest kept per account; older ones go first. */
const MAX_PER_ACCOUNT = 200;

export async function notify(
  userId: string | null | undefined,
  kind: NotificationKind,
  text: string,
  path: string | null = null,
): Promise<void> {
  if (!userId) return;
  try {
    await db.insert(notifications).values({ userId, kind, text, path });
    await db.execute(sql`
      DELETE FROM ${notifications}
      WHERE ${notifications.userId} = ${userId}
        AND ${notifications.id} NOT IN (
          SELECT ${notifications.id} FROM ${notifications}
          WHERE ${notifications.userId} = ${userId}
          ORDER BY ${notifications.createdAt} DESC
          LIMIT ${MAX_PER_ACCOUNT}
        )`);
  } catch (err) {
    console.warn("notification not stored", { kind, err });
    reportError(err, { notification: kind });
  }
}

export async function listNotifications(userId: string, limit = 50) {
  const rows = await db.query.notifications.findMany({
    where: eq(notifications.userId, userId),
    orderBy: [desc(notifications.createdAt)],
    limit,
  });
  const [{ unread }] = await db
    .select({ unread: sql<number>`count(*)` })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
  return { rows, unread: Number(unread) };
}

/** Mark `ids` (all when omitted) read; returns how many changed. */
export async function markRead(userId: string, ids?: string[]): Promise<number> {
  if (ids && ids.length === 0) return 0;
  const changed = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.userId, userId),
        isNull(notifications.readAt),
        ...(ids ? [inArray(notifications.id, ids)] : []),
      ),
    )
    .returning({ id: notifications.id });
  return changed.length;
}

/** Drop notifications past their keep time (a scheduler job). */
export async function pruneNotifications(now = Date.now()): Promise<number> {
  const removed = await db
    .delete(notifications)
    .where(lt(notifications.createdAt, new Date(now - NOTIFICATION_TTL_MS)))
    .returning({ id: notifications.id });
  return removed.length;
}
