import { db } from "../db/index.js";
import { instances } from "../db/schema.js";
import { eq, and, sql, desc, count, gte, lt } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import {
  type Principal,
  isEmptyOwnerPrincipal,
  parsePrincipal,
} from "@pekohub/shared";

// ─────────────────────────────────────────────────────────────────────────────
// Caller model
//
// `CallerPrincipal` is the union of the things that can knock on PekoHub's
// HTTP /v1/instances/:id/* endpoints. Today that's only authenticated
// users (kind = "user"). Post-#11, runtime-attested agent callers can
// also arrive — they're identified by a Principal with kind = "agent",
// transported in an `x-pekohub-caller-principal` header on the bridge
// request. Anonymous traffic (no auth, no header) maps to `null`.
// ─────────────────────────────────────────────────────────────────────────────

export type CallerPrincipal = Principal | null;

// ── Lookup stubs (TODO: replace with real tables once the teams model lands) ─

/**
 * Resolve the user ids that belong to a team.
 *
 * Gated on peko-runtime#11 (teams model). Until that lands, every team
 * is treated as having no members — which is the safe default: an
 * Agent-owned instance owned by a Team denies all access until the
 * team-membership table exists, rather than silently allowing everyone.
 */
async function teamMembersOf(_teamId: string): Promise<string[]> {
  return [];
}

// ── Backfill shim ──────────────────────────────────────────────────────────

/**
 * Resolve the effective owner of an instance.
 *
 * Three cases, in order of preference:
 *
 * 1. `instance.ownerPrincipal` is set and is not the empty sentinel
 *    `Principal::User("")` → use it.
 * 2. Otherwise, fall back to `Principal::User(instance.ownerId)`. This
 *    covers both pre-#11 rows (no `owner_principal` column at all) and
 *    post-#11 rows that were backfilled by the runtime migration with
 *    the empty sentinel
 *    ([peko-runtime/src/runtime/migration.rs:170-171, 234-235]).
 * 3. If even `ownerId` is null, return `null` (truly ownerless row).
 */
export function resolveOwnerPrincipal(
  instance: Pick<InstanceRecord, "ownerId" | "ownerPrincipal">,
): Principal | null {
  if (
    instance.ownerPrincipal &&
    !isEmptyOwnerPrincipal(instance.ownerPrincipal)
  ) {
    return instance.ownerPrincipal;
  }
  if (instance.ownerId) {
    return { kind: "user", id: String(instance.ownerId) };
  }
  return null;
}

// ── Core access predicate (issue #11) ──────────────────────────────────────

/**
 * Issue #11: the core access predicate. Replaces the ~9
 * `instance.ownerId !== user.id` sites in `routes/api/instances.ts`.
 *
 * `owner` is the resolved owner (see `resolveOwnerPrincipal`).
 * `caller` is the request's CallerPrincipal. `teamMembers` is a
 * lookup function for Team-kind owners; passed in so the function is
 * trivially mockable in unit tests and so the team-membership table
 * can land later without touching this signature.
 *
 * Returns `Promise<boolean>` because the Team case needs an async DB
 * lookup. The User and Agent cases short-circuit synchronously before
 * the await.
 */
export async function principalCanAccess(
  owner: Principal,
  caller: CallerPrincipal,
  teamMembers: (teamId: string) => Promise<string[]> = teamMembersOf,
): Promise<boolean> {
  // Public owner → world-readable, regardless of caller.
  if (owner.kind === "public") return true;

  // Anonymous caller (no auth, no header) can only see public owners
  // (handled above). All other owners are denied.
  if (caller === null) return false;
  if (caller.kind === "public") return false;

  // Same kind + same id → owner is the caller.
  if (owner.kind === caller.kind && owner.id === caller.id) return true;

  // Team owner: caller must be a team member.
  if (owner.kind === "team" && caller.kind === "user") {
    const members = await teamMembers(owner.id);
    return members.includes(caller.id);
  }

  // Cross-kind pairs and Agent→User / User→Agent are denied by
  // default. The cross-kind guard is the whole point of the
  // typed-principal model: `Principal::User("alice")` must not match
  // `Principal::Agent("alice")` even though their string ids collide.
  return false;
}

// ── Allow-list check (matches a caller against instance.allow) ──────────────

/**
 * True if `caller` matches the instance's typed `allowedPrincipals`
 * allow-list OR the legacy `allowedUsers` allow-list (User-kind only).
 *
 * Public-kind callers are never on an allow-list (public access goes
 * through `instance.exposure === "public"` at a higher level).
 */
function principalInAllowList(
  instance: Pick<InstanceRecord, "allowedUsers" | "allowedPrincipals">,
  caller: CallerPrincipal,
): boolean {
  if (caller === null) return false;
  if (caller.kind === "public") return false;
  if (caller.kind === "user") {
    // Legacy: bare user-id strings in `allowedUsers`.
    if (instance.allowedUsers.some((u) => String(u) === caller.id)) {
      return true;
    }
  }
  return instance.allowedPrincipals.some(
    (p) => p.kind === caller.kind && p.id === caller.id,
  );
}

// ── Instance model types ───────────────────────────────────────────────────

export type InstanceType = "agent" | "team";
export type InstanceStatus = "online" | "offline" | "busy" | "error";
export type InstanceExposure = "unexposed" | "private" | "public";

export type PublicCategory =
  | "productivity"
  | "coding"
  | "creative"
  | "business"
  | "entertainment"
  | "education"
  | "other";

export interface InstanceRecord {
  id: string;
  type: InstanceType;
  name: string;
  ownerId: number;
  ownerPrincipal: Principal | null;
  runtimeId: string;
  runtimeDisplayName: string | null;
  bundleRef: string | null;
  status: InstanceStatus;
  exposure: InstanceExposure;
  allowedUsers: string[];
  allowedPrincipals: Principal[];
  lastSeenAt: Date | null;
  createdAt: Date;
  capabilities: string[];
  metadata: Record<string, unknown>;

  // Public profile (ADR-003)
  publicName: string | null;
  description: string | null;
  tags: string[];
  category: PublicCategory | null;
  tosRequired: boolean;
  tosText: string | null;
  dailyQuota: number | null;
  weeklyQuota: number | null;

  // Discovery & curation
  publishedAt: Date | null;
  featured: boolean;

  // Monetization hooks
  monetization: {
    enabled: boolean;
    pricingModel: "free" | "subscription" | "usage" | null;
    priceCents: number | null;
    stripeProductId: string | null;
  };
}

export interface CreateInstanceInput {
  id?: string;
  type: InstanceType;
  name: string;
  ownerId: number;
  ownerPrincipal?: Principal | null;
  runtimeId: string;
  runtimeDisplayName?: string;
  bundleRef?: string;
  status?: InstanceStatus;
  exposure?: InstanceExposure;
  allowedUsers?: string[];
  allowedPrincipals?: Principal[];
  capabilities?: string[];
  metadata?: Record<string, unknown>;

  // Public profile
  publicName?: string;
  description?: string;
  tags?: string[];
  category?: PublicCategory;
  tosRequired?: boolean;
  tosText?: string;
  dailyQuota?: number;
  weeklyQuota?: number;
}

export interface UpdateInstanceInput {
  name?: string;
  runtimeDisplayName?: string;
  status?: InstanceStatus;
  exposure?: InstanceExposure;
  allowedUsers?: string[];
  allowedPrincipals?: Principal[];
  capabilities?: string[];
  metadata?: Record<string, unknown>;

  // Public profile
  publicName?: string;
  description?: string;
  tags?: string[];
  category?: PublicCategory;
  tosRequired?: boolean;
  tosText?: string;
  dailyQuota?: number;
  weeklyQuota?: number;
  publishedAt?: Date | null;
  featured?: boolean;
}

export interface ListInstancesOptions {
  ownerId?: number;
  ownerPrincipal?: Principal;
  runtimeId?: string;
  status?: InstanceStatus;
  type?: InstanceType;
  exposure?: InstanceExposure;
  page?: number;
  perPage?: number;
}

export interface ListInstancesResult {
  data: InstanceRecord[];
  total: number;
}

export interface ProxiedRequestPayload {
  requestId: string;
  instanceId: string;
  method: "chat" | "stream";
  body: unknown;
  headers: Record<string, string>;
}

export interface ProxiedResponsePayload {
  requestId: string;
  status: number;
  body: unknown;
}

export interface StreamChunkPayload {
  requestId: string;
  chunk: string;
  done: boolean;
}

// ── Defensive parser: wire → Principal (issue #11) ─────────────────────────

/**
 * Coerce a wire string (e.g. `"user:42"` or `"agent:helper"`) into a
 * `Principal`. Returns `null` if the string can't be parsed — callers
 * treat that as "ignore this entry" rather than throw, so a single
 * malformed entry doesn't poison the whole allow-list.
 */
function parseAllowEntry(s: string): Principal | null {
  return parsePrincipal(s);
}

// ── Service ────────────────────────────────────────────────────────────────

/**
 * Instance management service.
 * Handles CRUD operations and tunnel-mediated proxying.
 */
export class InstanceService {
  // ── CRUD ───────────────────────────────────────────────────────────────────

  async create(input: CreateInstanceInput): Promise<InstanceRecord> {
    // Resolve ownerPrincipal: prefer the input, otherwise backfill from
    // the legacy ownerId.
    const ownerPrincipal =
      input.ownerPrincipal !== undefined
        ? input.ownerPrincipal
        : input.ownerId
          ? { kind: "user" as const, id: String(input.ownerId) }
          : null;

    const [row] = await db
      .insert(instances)
      .values({
        id: input.id,
        type: input.type,
        name: input.name,
        ownerId: input.ownerId,
        ownerPrincipal,
        runtimeId: input.runtimeId,
        runtimeDisplayName: input.runtimeDisplayName ?? null,
        bundleRef: input.bundleRef ?? null,
        status: input.status ?? "offline",
        exposure: input.exposure ?? "unexposed",
        allowedUsers: input.allowedUsers ?? [],
        allowedPrincipals: input.allowedPrincipals ?? [],
        capabilities: input.capabilities ?? [],
        metadata: input.metadata ?? {},
        lastSeenAt: input.status === "online" ? new Date() : null,
        publicName: input.publicName ?? null,
        description: input.description ?? null,
        tags: input.tags ?? [],
        category: input.category ?? null,
        tosRequired: input.tosRequired ?? false,
        tosText: input.tosText ?? null,
        dailyQuota: input.dailyQuota ?? null,
        weeklyQuota: input.weeklyQuota ?? null,
      })
      .returning();

    return this.toRecord(row);
  }

  async getById(id: string): Promise<InstanceRecord | null> {
    const row = await db.query.instances.findFirst({
      where: eq(instances.id, id),
    });
    return row ? this.toRecord(row) : null;
  }

  async list(options: ListInstancesOptions = {}): Promise<ListInstancesResult> {
    const {
      ownerId,
      ownerPrincipal,
      runtimeId,
      status,
      type,
      exposure,
      page = 1,
      perPage = 20,
    } = options;

    const conditions: SQL[] = [];
    if (ownerId !== undefined) conditions.push(eq(instances.ownerId, ownerId));
    if (ownerPrincipal !== undefined) {
      // JSONB equality is exact-match. For "list my instances as user X"
      // we use the legacy `ownerId` column (numeric FK). The principal
      // filter is for the typed case (e.g. list all Agent-owned
      // instances for a given agent id).
      conditions.push(sql`${instances.ownerPrincipal} = ${JSON.stringify(ownerPrincipal)}::jsonb`);
    }
    if (runtimeId !== undefined)
      conditions.push(eq(instances.runtimeId, runtimeId));
    if (status !== undefined) conditions.push(eq(instances.status, status));
    if (type !== undefined) conditions.push(eq(instances.type, type));
    if (exposure !== undefined)
      conditions.push(eq(instances.exposure, exposure));

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [rows, totalResult] = await Promise.all([
      db
        .select()
        .from(instances)
        .where(whereClause)
        .orderBy(desc(instances.createdAt))
        .limit(perPage)
        .offset((page - 1) * perPage),
      db.select({ count: count() }).from(instances).where(whereClause),
    ]);

    return {
      data: rows.map((r) => this.toRecord(r)),
      total: totalResult[0]?.count ?? 0,
    };
  }

  async update(
    id: string,
    input: UpdateInstanceInput,
  ): Promise<InstanceRecord | null> {
    const existing = await this.getById(id);
    if (!existing) return null;

    const values: Record<string, unknown> = {};
    if (input.name !== undefined) values.name = input.name;
    if (input.runtimeDisplayName !== undefined)
      values.runtimeDisplayName = input.runtimeDisplayName;
    if (input.status !== undefined) {
      values.status = input.status;
      if (input.status === "offline") {
        // Don't update lastSeenAt — it should reflect last time the instance was online
      } else if (existing.status === "offline" && input.status === "online") {
        // Transitioning from offline to online: update lastSeenAt to now
        values.lastSeenAt = new Date();
      } else if (
        input.status === "online" ||
        input.status === "busy" ||
        input.status === "error"
      ) {
        values.lastSeenAt = new Date();
      }
    }
    if (input.exposure !== undefined) values.exposure = input.exposure;
    if (input.allowedUsers !== undefined)
      values.allowedUsers = input.allowedUsers;
    if (input.allowedPrincipals !== undefined)
      values.allowedPrincipals = input.allowedPrincipals;
    if (input.capabilities !== undefined)
      values.capabilities = input.capabilities;
    if (input.metadata !== undefined) values.metadata = input.metadata;
    if (input.publicName !== undefined) values.publicName = input.publicName;
    if (input.description !== undefined) values.description = input.description;
    if (input.tags !== undefined) values.tags = input.tags;
    if (input.category !== undefined) values.category = input.category;
    if (input.tosRequired !== undefined) values.tosRequired = input.tosRequired;
    if (input.tosText !== undefined) values.tosText = input.tosText;
    if (input.dailyQuota !== undefined) values.dailyQuota = input.dailyQuota;
    if (input.weeklyQuota !== undefined) values.weeklyQuota = input.weeklyQuota;
    if (input.publishedAt !== undefined) values.publishedAt = input.publishedAt;
    if (input.featured !== undefined) values.featured = input.featured;

    if (Object.keys(values).length === 0) {
      return this.getById(id);
    }

    const [row] = await db
      .update(instances)
      .set(values)
      .where(eq(instances.id, id))
      .returning();

    return row ? this.toRecord(row) : null;
  }

  async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(instances)
      .where(eq(instances.id, id))
      .returning();
    return result.length > 0;
  }

  async upsertFromAnnounce(
    input: CreateInstanceInput,
  ): Promise<InstanceRecord> {
    const existing = input.id ? await this.getById(input.id) : null;
    if (existing) {
      const values: UpdateInstanceInput & { bundleRef?: string } = {
        name: input.name,
        runtimeDisplayName: input.runtimeDisplayName,
        status: input.status,
        exposure: input.exposure,
        allowedUsers: input.allowedUsers,
        allowedPrincipals: input.allowedPrincipals,
        capabilities: input.capabilities,
        metadata: input.metadata,
      };
      if (input.bundleRef !== undefined) values.bundleRef = input.bundleRef;
      const updated = await this.update(input.id!, values);
      return updated!;
    }
    return this.create(input);
  }

  // ── Heartbeat / Status ─────────────────────────────────────────────────────

  async heartbeat(id: string, status: InstanceStatus): Promise<void> {
    await db
      .update(instances)
      .set({ status, lastSeenAt: new Date() })
      .where(eq(instances.id, id));
  }

  async markOfflineIfStale(timeoutMs: number = 60_000): Promise<number> {
    const cutoff = new Date(Date.now() - timeoutMs);
    const result = await db
      .update(instances)
      .set({ status: "offline" })
      .where(
        and(eq(instances.status, "online"), lt(instances.lastSeenAt, cutoff)),
      )
      .returning({ id: instances.id });
    return result.length;
  }

  // ── Permissions (issue #11) ────────────────────────────────────────────────

  /**
   * True if `caller` can read this instance (any non-mutating operation:
   * GET, search, public profile page, etc.).
   *
   * Order of checks:
   * 1. Public exposure → world-readable.
   * 2. Null caller → denied (public is the only anonymous-friendly path).
   * 3. Resolved owner === caller → allowed (owner can always see).
   * 4. Caller on the allow-list (`allowedPrincipals` or legacy
   *    `allowedUsers`) → allowed.
   * 5. Otherwise → denied.
   */
  async canAccess(
    instance: InstanceRecord,
    caller: CallerPrincipal | number | null,
  ): Promise<boolean> {
    if (instance.exposure === "public") return true;

    const c = normalizeCaller(caller);
    if (c === null) return false;

    const owner = resolveOwnerPrincipal(instance);
    if (owner && (await principalCanAccess(owner, c))) return true;

    return principalInAllowList(instance, c);
  }

  /**
   * True if `caller` can chat with this instance (POST /v1/instances/:id/chat
   * and GET /v1/instances/:id/stream).
   *
   * `canAccess` + the same offline / unexposed / public gates.
   * Unexposed and offline instances deny even owners; public allows
   * anonymous.
   */
  async canChat(
    instance: InstanceRecord,
    caller: CallerPrincipal | number | null,
  ): Promise<boolean> {
    if (instance.status === "offline" || instance.exposure === "unexposed") {
      return false;
    }
    if (instance.exposure === "public") return true;

    const c = normalizeCaller(caller);
    if (c === null) return false;

    const owner = resolveOwnerPrincipal(instance);
    if (owner && (await principalCanAccess(owner, c))) return true;

    return principalInAllowList(instance, c);
  }

  /**
   * True if `caller` is the resolved owner of `instance`. This is the
   * issue #11 replacement for the legacy
   * `instance.ownerId !== user.id` check at the ~9 owner-check sites
   * in `routes/api/instances.ts`. Returns `false` if the instance has
   * no resolvable owner.
   */
  async isOwner(
    instance: InstanceRecord,
    caller: CallerPrincipal | number | null,
  ): Promise<boolean> {
    const owner = resolveOwnerPrincipal(instance);
    if (owner === null) return false;
    const c = normalizeCaller(caller);
    if (c === null) return false;
    return principalCanAccess(owner, c);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private toRecord(row: typeof instances.$inferSelect): InstanceRecord {
    const monetization = (row.monetization as Record<
      string,
      unknown
    > | null) ?? {
      enabled: false,
      pricingModel: null,
      priceCents: null,
      stripeProductId: null,
    };
    return {
      id: row.id,
      type: row.type as InstanceType,
      name: row.name,
      ownerId: row.ownerId,
      ownerPrincipal: (row.ownerPrincipal as Principal | null) ?? null,
      runtimeId: row.runtimeId,
      runtimeDisplayName: row.runtimeDisplayName,
      bundleRef: row.bundleRef,
      status: row.status as InstanceStatus,
      exposure: row.exposure as InstanceExposure,
      allowedUsers: (row.allowedUsers as string[]) ?? [],
      allowedPrincipals: (row.allowedPrincipals as Principal[]) ?? [],
      lastSeenAt: row.lastSeenAt,
      createdAt: row.createdAt,
      capabilities: (row.capabilities as string[]) ?? [],
      metadata: (row.metadata as Record<string, unknown>) ?? {},
      publicName: row.publicName ?? null,
      description: row.description ?? null,
      tags: (row.tags as string[]) ?? [],
      category: (row.category as PublicCategory | null) ?? null,
      tosRequired: row.tosRequired ?? false,
      tosText: row.tosText ?? null,
      dailyQuota: row.dailyQuota ?? null,
      weeklyQuota: row.weeklyQuota ?? null,
      publishedAt: row.publishedAt ?? null,
      featured: row.featured ?? false,
      monetization: {
        enabled: (monetization.enabled as boolean) ?? false,
        pricingModel:
          (monetization.pricingModel as
            | "free"
            | "subscription"
            | "usage"
            | null) ?? null,
        priceCents: (monetization.priceCents as number | null) ?? null,
        stripeProductId:
          (monetization.stripeProductId as string | null) ?? null,
      },
    };
  }
}

// ── Caller normalization shim (back-compat) ────────────────────────────────

/**
 * Coerce the various caller shapes callers pass in to a unified
 * `CallerPrincipal`. Accepts:
 *
 * - `null` → null (unauthenticated)
 * - `number` → `Principal::User(String(n))` (the legacy `userId: number`
 *   shape from the auth plugin)
 * - `Principal` → as-is
 */
function normalizeCaller(
  caller: CallerPrincipal | number | null,
): CallerPrincipal {
  if (caller === null || caller === undefined) return null;
  if (typeof caller === "number") {
    return { kind: "user", id: String(caller) };
  }
  return caller;
}

// Re-export the wire-format helper for use by route handlers that
// parse legacy `allowedUsers` strings (the runtime may still send
// bare user ids in the `allowed_users` field of an announce).
export { parseAllowEntry as _parseAllowEntry };

export const instanceService = new InstanceService();
