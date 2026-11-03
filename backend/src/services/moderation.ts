import type { FastifyInstance } from "fastify";
import { and, count, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import { formatHubRef, parseHubRef } from "@pekohub/shared";
import { db } from "../db/index.js";
import {
  bundles,
  bundleVersions,
  hubGroups,
  hubPrincipals,
  instances,
  reports,
  runtimes,
  users,
  type ReportReason,
  type ReportStatus,
  type ReportTargetKind,
} from "../db/schema.js";
import { hasRole, type AuthenticatedUser } from "../plugins/auth.js";
import { auditService } from "./audit.js";
import { findSeed, reindexSeed, unindexSeed } from "./seed-store.js";
import { instanceService } from "./instances.js";

/**
 * Trust & safety (gap map B2): reports from signed-in people, and the
 * moderator actions that answer them. Every action writes an audit event
 * in the `moderation` namespace.
 *
 *   seed     hide the seed, or yank one version
 *   peko     force it off the Hub (exposure `local_only`, pushed down its
 *            tunnel); it can't come back online until a moderator restores it
 *   account  suspend: its credentials fail, its refresh tokens are revoked,
 *            and its runtimes are closed and refused at the tunnel handshake
 */

export type Result<T> = ({ ok: true } & T) | { ok: false; status: 400 | 403 | 404 | 409 | 429; error: string };

function fail(status: 400 | 403 | 404 | 409 | 429, error: string): { ok: false; status: typeof status; error: string } {
  return { ok: false, status, error };
}

// ── Reports ─────────────────────────────────────────────────────────────────

/** Reports one account may file in an hour. */
export const REPORTS_PER_HOUR = 10;
const GROUP_ID = /^[1-9][0-9]{0,18}$/;

export interface ReportTarget {
  kind: ReportTargetKind;
  /** The canonical ID: `alice/ada@1.0.0`, `@alice/ada`, `@alice`, or a group ID. */
  target: string;
  targetId: string | null;
  accountId: string | null;
}

/**
 * What a report names, if it is there to report: a shown seed (or one of
 * its versions), a public peko, a person, or a group by its ID. A group's
 * existence is never revealed (invite-only groups aren't public), so any
 * well-formed group ID is accepted.
 */
export async function resolveReportTarget(input: string): Promise<Result<{ target: ReportTarget }>> {
  const text = input.trim();
  if (GROUP_ID.test(text) && BigInt(text) < 2n ** 63n) {
    const group = await db.query.hubGroups.findFirst({ where: eq(hubGroups.id, BigInt(text)) });
    return {
      ok: true,
      target: { kind: "group", target: text, targetId: text, accountId: group?.ownerId ?? null },
    };
  }
  const ref = parseHubRef(text);
  if (!ref) {
    return fail(400, "Report a seed (owner/name), a peko (@owner/name), a person (@handle), or a group ID");
  }
  switch (ref.kind) {
    case "seed": {
      const found = await findSeed(ref.owner, ref.name);
      if (!found || (ref.version && !found.versions.some((v) => v.version === ref.version))) {
        return fail(404, "No such seed");
      }
      return {
        ok: true,
        target: {
          kind: "seed",
          target: formatHubRef({ ...ref, owner: found.bundle.namespace, name: found.bundle.name }),
          targetId: null,
          accountId: found.bundle.publisherId,
        },
      };
    }
    case "peko": {
      const peko = await instanceService.getByHandle(ref.owner, ref.name);
      if (!peko || peko.exposure !== "public" || !peko.hubId) return fail(404, "No such peko");
      const owner = peko.ownerSubject?.kind === "user" ? String(peko.ownerSubject.id) : null;
      return {
        ok: true,
        target: { kind: "peko", target: formatHubRef({ ...ref, name: peko.name }), targetId: peko.hubId, accountId: owner },
      };
    }
    case "person": {
      const person = await db.query.users.findFirst({
        where: and(eq(users.namespace, ref.handle), isNull(users.suspendedAt)),
      });
      if (!person) return fail(404, "No one has that handle");
      return {
        ok: true,
        target: { kind: "person", target: formatHubRef(ref), targetId: person.id, accountId: person.id },
      };
    }
  }
}

/** File a report; a second open report of the same thing by the same person is the first one. */
export async function fileReport(
  reporter: AuthenticatedUser,
  input: { target: string; reason: ReportReason; note?: string },
): Promise<Result<{ report: typeof reports.$inferSelect; duplicate: boolean }>> {
  const resolved = await resolveReportTarget(input.target);
  if (!resolved.ok) return resolved;
  const { target } = resolved;

  const existing = await db.query.reports.findFirst({
    where: and(
      eq(reports.reporterId, reporter.id),
      eq(reports.targetKind, target.kind),
      eq(reports.target, target.target),
      eq(reports.status, "open"),
    ),
  });
  if (existing) return { ok: true, report: existing, duplicate: true };

  const [{ recent }] = await db
    .select({ recent: count() })
    .from(reports)
    .where(and(eq(reports.reporterId, reporter.id), gte(reports.createdAt, new Date(Date.now() - 3_600_000))));
  if (recent >= REPORTS_PER_HOUR) {
    return fail(429, `You can send ${REPORTS_PER_HOUR} reports an hour. Try again later.`);
  }

  const [report] = await db
    .insert(reports)
    .values({
      reporterId: reporter.id,
      targetKind: target.kind,
      target: target.target,
      targetId: target.targetId,
      accountId: target.accountId,
      reason: input.reason,
      note: input.note?.trim() || null,
    })
    .returning();
  return { ok: true, report, duplicate: false };
}

export interface ReportView {
  id: string;
  targetKind: ReportTargetKind;
  target: string;
  targetId: string | null;
  reason: ReportReason;
  note: string | null;
  status: ReportStatus;
  createdAt: string;
  reporter: { handle: string } | null;
  /** The account answerable for the target, and whether it is suspended now. */
  account: { id: string; handle: string; suspended: boolean } | null;
  /** The target is hidden, yanked, or off the Hub now. */
  targetRemoved: boolean;
  resolvedBy: { handle: string } | null;
  resolvedAt: string | null;
  resolution: string | null;
}

/** The moderation queue, newest first. */
export async function listReports(options: {
  status?: ReportStatus;
  page: number;
  perPage: number;
}): Promise<{ reports: ReportView[]; total: number; page: number; perPage: number }> {
  const where = options.status ? eq(reports.status, options.status) : undefined;
  const [rows, [{ total }]] = await Promise.all([
    db
      .select()
      .from(reports)
      .where(where)
      .orderBy(desc(reports.createdAt))
      .limit(options.perPage)
      .offset((options.page - 1) * options.perPage),
    db.select({ total: count() }).from(reports).where(where),
  ]);

  const accountIds = [
    ...new Set(rows.flatMap((r) => [r.reporterId, r.accountId, r.resolvedBy]).filter((id): id is string => !!id)),
  ];
  const people = accountIds.length
    ? await db.select().from(users).where(inArray(users.id, accountIds))
    : [];
  const byId = new Map(people.map((p) => [p.id, p]));
  const handleOf = (id: string | null) => {
    const person = id ? byId.get(id) : undefined;
    return person ? { handle: person.namespace } : null;
  };

  return {
    reports: await Promise.all(
      rows.map(async (r) => {
        const account = r.accountId ? byId.get(r.accountId) : undefined;
        return {
          id: r.id,
          targetKind: r.targetKind,
          target: r.target,
          targetId: r.targetId,
          reason: r.reason,
          note: r.note,
          status: r.status,
          createdAt: r.createdAt.toISOString(),
          reporter: handleOf(r.reporterId),
          account: account
            ? { id: account.id, handle: account.namespace, suspended: account.suspendedAt !== null }
            : null,
          targetRemoved: await isTargetRemoved(r),
          resolvedBy: handleOf(r.resolvedBy),
          resolvedAt: r.resolvedAt?.toISOString() ?? null,
          resolution: r.resolution,
        };
      }),
    ),
    total: Number(total),
    page: options.page,
    perPage: options.perPage,
  };
}

async function isTargetRemoved(report: typeof reports.$inferSelect): Promise<boolean> {
  switch (report.targetKind) {
    case "seed": {
      const ref = parseHubRef(report.target);
      if (ref?.kind !== "seed") return false;
      const bundle = await db.query.bundles.findFirst({
        where: and(eq(bundles.namespace, ref.owner), eq(bundles.name, ref.name)),
      });
      if (!bundle) return true;
      if (bundle.hiddenAt) return true;
      if (!ref.version) return false;
      const version = await db.query.bundleVersions.findFirst({
        where: and(eq(bundleVersions.bundleId, bundle.id), eq(bundleVersions.version, ref.version)),
      });
      return !version || version.yankedAt !== null;
    }
    case "peko": {
      if (!report.targetId) return false;
      const identity = await db.query.hubPrincipals.findFirst({ where: eq(hubPrincipals.id, report.targetId) });
      return !identity || identity.takenDownAt !== null;
    }
    case "person":
    case "group":
      return false;
  }
}

/** Close a report (or reopen one) with a moderator's word on it. */
export async function resolveReport(
  moderator: AuthenticatedUser,
  reportId: string,
  status: ReportStatus,
  resolution: string | null,
): Promise<Result<{ report: typeof reports.$inferSelect }>> {
  const closing = status !== "open";
  const [report] = await db
    .update(reports)
    .set({
      status,
      resolvedBy: closing ? moderator.id : null,
      resolvedAt: closing ? new Date() : null,
      resolution: closing ? resolution : null,
    })
    .where(eq(reports.id, reportId))
    .returning();
  if (!report) return fail(404, "No such report");
  await auditService.logModeration(`report.${status}`, moderator.id, `report:${report.id}`, {
    target: report.target,
    resolution,
  });
  return { ok: true, report };
}

/** An action taken on a report closes it as actioned. */
async function closeReportFor(moderator: AuthenticatedUser, reportId: string | undefined, resolution: string) {
  if (!reportId) return;
  await resolveReport(moderator, reportId, "actioned", resolution);
}

// ── Actions ─────────────────────────────────────────────────────────────────

export interface ActionInput {
  reason?: string;
  /** The report this answers; it is closed as actioned. */
  reportId?: string;
}

/** Hide a seed (every version) or show it again. */
export async function setSeedHidden(
  fastify: FastifyInstance,
  moderator: AuthenticatedUser,
  owner: string,
  name: string,
  hidden: boolean,
  input: ActionInput,
): Promise<Result<{ hidden: boolean }>> {
  const bundle = await db.query.bundles.findFirst({
    where: and(eq(bundles.namespace, owner), eq(bundles.name, name)),
  });
  if (!bundle) return fail(404, "No such seed");
  await db
    .update(bundles)
    .set({ hiddenAt: hidden ? new Date() : null, hiddenReason: hidden ? (input.reason ?? null) : null })
    .where(eq(bundles.id, bundle.id));
  if (hidden) await unindexSeed(fastify, bundle.namespace, bundle.name);
  else await reindexSeed(fastify, bundle.namespace, bundle.name);
  const resource = formatHubRef({ kind: "seed", owner: bundle.namespace, name: bundle.name });
  await auditService.logModeration(hidden ? "seed.hide" : "seed.unhide", moderator.id, resource, {
    reason: input.reason ?? null,
    reportId: input.reportId ?? null,
  });
  if (hidden) await closeReportFor(moderator, input.reportId, `Hid ${resource}`);
  return { ok: true, hidden };
}

/** Yank one version of a seed, or restore it. */
export async function setSeedVersionYanked(
  fastify: FastifyInstance,
  moderator: AuthenticatedUser,
  owner: string,
  name: string,
  version: string,
  yanked: boolean,
  input: ActionInput,
): Promise<Result<{ version: string; yanked: boolean }>> {
  const bundle = await db.query.bundles.findFirst({
    where: and(eq(bundles.namespace, owner), eq(bundles.name, name)),
  });
  const row = bundle
    ? await db.query.bundleVersions.findFirst({
        where: and(eq(bundleVersions.bundleId, bundle.id), eq(bundleVersions.version, version)),
      })
    : undefined;
  if (!bundle || !row) return fail(404, "No such seed version");
  await db
    .update(bundleVersions)
    .set({ yankedAt: yanked ? new Date() : null, yankedReason: yanked ? (input.reason ?? null) : null })
    .where(eq(bundleVersions.id, row.id));
  await reindexSeed(fastify, bundle.namespace, bundle.name);
  const resource = formatHubRef({ kind: "seed", owner: bundle.namespace, name: bundle.name, version });
  await auditService.logModeration(yanked ? "seed.yank" : "seed.unyank", moderator.id, resource, {
    reason: input.reason ?? null,
    reportId: input.reportId ?? null,
  });
  if (yanked) await closeReportFor(moderator, input.reportId, `Yanked ${resource}`);
  return { ok: true, version, yanked };
}

/**
 * Force a peko off the Hub, or let it come back. Off: its instance goes
 * `local_only` and its runtime is told over the tunnel, as an owner's
 * exposure change is; the flag on its identity keeps it from re-announcing.
 * Restoring only lifts the flag — the owner puts it back online.
 */
export async function setPekoTakenDown(
  fastify: FastifyInstance,
  moderator: AuthenticatedUser,
  hubId: string,
  takenDown: boolean,
  input: ActionInput,
): Promise<Result<{ takenDown: boolean; tunnelNotified: boolean }>> {
  const identity = /^[0-9a-f-]{36}$/i.test(hubId)
    ? await db.query.hubPrincipals.findFirst({ where: eq(hubPrincipals.id, hubId) })
    : undefined;
  if (!identity) return fail(404, "No such peko");
  await db
    .update(hubPrincipals)
    .set({
      takenDownAt: takenDown ? new Date() : null,
      takenDownReason: takenDown ? (input.reason ?? null) : null,
    })
    .where(eq(hubPrincipals.id, hubId));

  let tunnelNotified = false;
  const instance = await instanceService.getByHubId(hubId);
  if (takenDown && instance && instance.exposure !== "local_only") {
    await instanceService.update(instance.id, { exposure: "local_only" });
    if (fastify.tunnelManager.isRuntimeConnected(instance.runtimeId)) {
      await fastify.tunnelRouter.sendControl(instance.runtimeId, {
        type: "exposure_update",
        payload: { instanceId: instance.id, exposure: "local_only" },
      });
      tunnelNotified = true;
    }
  }
  const owner =
    instance?.ownerSubject?.kind === "user"
      ? await db.query.users.findFirst({ where: eq(users.id, String(instance.ownerSubject.id)) })
      : undefined;
  const resource =
    instance && owner ? formatHubRef({ kind: "peko", owner: owner.namespace, name: instance.name }) : `peko:${hubId}`;
  await auditService.logModeration(takenDown ? "peko.takedown" : "peko.restore", moderator.id, resource, {
    hubId,
    instanceId: instance?.id ?? null,
    reason: input.reason ?? null,
    reportId: input.reportId ?? null,
  });
  if (takenDown) await closeReportFor(moderator, input.reportId, `Took ${resource} off PekoHub`);
  return { ok: true, takenDown, tunnelNotified };
}

/** Find an account by its ID or handle. */
async function findAccount(ref: string) {
  return /^[0-9a-f-]{36}$/i.test(ref)
    ? db.query.users.findFirst({ where: eq(users.id, ref) })
    : db.query.users.findFirst({ where: eq(users.namespace, ref.replace(/^@/, "").toLowerCase()) });
}

/**
 * Suspend an account, or lift a suspension. A moderator suspends people;
 * only an admin suspends a moderator; no one suspends an admin or
 * themselves.
 */
export async function setAccountSuspended(
  fastify: FastifyInstance,
  moderator: AuthenticatedUser,
  accountRef: string,
  suspended: boolean,
  input: ActionInput,
): Promise<Result<{ suspended: boolean; runtimesClosed: number }>> {
  const account = await findAccount(accountRef);
  if (!account) return fail(404, "No such account");
  if (account.id === moderator.id) return fail(403, "You can't suspend your own account");
  if (account.role === "admin" || (account.role === "moderator" && !hasRole(moderator.role, "admin"))) {
    return fail(403, `Only an admin can suspend a ${account.role}`);
  }

  await db
    .update(users)
    .set({
      suspendedAt: suspended ? new Date() : null,
      suspendedReason: suspended ? (input.reason ?? null) : null,
      updatedAt: new Date(),
    })
    .where(eq(users.id, account.id));

  let runtimesClosed = 0;
  if (suspended) {
    await fastify.revokeAllUserRefreshTokens(account.id);
    const owned = await db
      .select({ runtimeDid: runtimes.runtimeDid })
      .from(runtimes)
      .where(eq(runtimes.ownerId, account.id));
    for (const { runtimeDid } of owned) {
      if (fastify.tunnelManager.isRuntimeConnected(runtimeDid)) runtimesClosed++;
      fastify.tunnelManager.disconnectRuntime(runtimeDid, "account suspended");
    }
    // Its pekos are offline with their tunnels; the sweep would get there too.
    if (owned.length > 0) {
      await db
        .update(instances)
        .set({ status: "offline" })
        .where(inArray(instances.runtimeId, owned.map((r) => r.runtimeDid)));
    }
  }

  const resource = formatHubRef({ kind: "person", handle: account.namespace });
  await auditService.logModeration(suspended ? "account.suspend" : "account.unsuspend", moderator.id, resource, {
    accountId: account.id,
    reason: input.reason ?? null,
    reportId: input.reportId ?? null,
    runtimesClosed,
  });
  if (suspended) await closeReportFor(moderator, input.reportId, `Suspended ${resource}`);
  return { ok: true, suspended, runtimesClosed };
}

/** An admin grants or removes a role. Admins can't change their own. */
export async function setAccountRole(
  admin: AuthenticatedUser,
  accountRef: string,
  role: (typeof users.$inferSelect)["role"],
): Promise<Result<{ handle: string; role: typeof role }>> {
  const account = await findAccount(accountRef);
  if (!account) return fail(404, "No such account");
  if (account.id === admin.id) return fail(403, "You can't change your own role");
  await db.update(users).set({ role, updatedAt: new Date() }).where(eq(users.id, account.id));
  await auditService.logModeration("account.role", admin.id, formatHubRef({ kind: "person", handle: account.namespace }), {
    accountId: account.id,
    from: account.role,
    to: role,
  });
  return { ok: true, handle: account.namespace, role };
}

/** Whether a peko's identity was forced off the Hub (refuses it at announce and exposure). */
export async function isTakenDown(hubId: string | null | undefined): Promise<boolean> {
  if (!hubId) return false;
  const identity = await db.query.hubPrincipals.findFirst({ where: eq(hubPrincipals.id, hubId) });
  return identity?.takenDownAt != null;
}
