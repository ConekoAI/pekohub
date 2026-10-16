import { db } from "../db/index.js";
import { instances, runtimes, users, hubPrincipals, principalMoveApprovals } from "../db/schema.js";
import { eq, and, sql, desc, count, gte, lt, ne, inArray } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import {
  Subject,
  isEmptyOwnerSubject,
  parseSubject,
} from "@pekohub/shared";

// ─────────────────────────────────────────────────────────────────────────────
// Caller model
//
// `CallerSubject` is the union of the things that can knock on PekoHub's
// HTTP /v1/instances/:id/* endpoints. Today that's only authenticated
// users (kind = "user"). Post-#11, runtime-attested principal callers
// can also arrive — they're identified by a Subject with kind =
// "principal", transported in an `x-pekohub-caller-principal` header
// on the bridge request. Anonymous traffic (no auth, no header) maps
// to `null`.
// ─────────────────────────────────────────────────────────────────────────────

export type CallerSubject = Subject | null;

// ── Backfill shim ──────────────────────────────────────────────────────────

/**
 * Resolve the effective owner of an instance.
 *
 * Post-H1 the typed `owner_subject` JSONB column is the only source
 * of truth — the legacy `owner_id` integer FK was dropped in
 * migration 0010. Two cases remain:
 *
 * 1. `instance.ownerSubject` is set and is not the empty sentinel
 *    `Subject::User("")` → use it.
 * 2. Otherwise, return `null` (truly ownerless row).
 */
export function resolveOwnerSubject(
  instance: Pick<InstanceRecord, "ownerSubject">,
): Subject | null {
  if (
    instance.ownerSubject &&
    !isEmptyOwnerSubject(instance.ownerSubject)
  ) {
    return instance.ownerSubject;
  }
  return null;
}

// ── Core access predicate (issue #11, ADR-041 clean break) ────────────────

/**
 * ADR-041: the core access predicate. The Team subject variant was
 * removed; only `User` and `Principal` carry per-instance identity.
 *
 * `owner` is the resolved owner (see `resolveOwnerSubject`).
 * `caller` is the request's `CallerSubject`.
 *
 * Returns `Promise<boolean>` so the function signature is forward
 * compatible with future async lookups (e.g. delegations); today's
 * path short-circuits synchronously.
 */
export async function subjectCanAccess(
  owner: Subject,
  caller: CallerSubject,
): Promise<boolean> {
  // Public owner → world-readable, regardless of caller.
  if (owner.kind === "public") return true;

  // Anonymous caller (no auth, no header) can only see public owners
  // (handled above). All other owners are denied.
  if (caller === null) return false;
  if (caller.kind === "public") return false;

  // Same kind + same id → owner is the caller.
  if (owner.kind === caller.kind && owner.id === caller.id) return true;

  // Cross-kind pairs and Principal→User / User→Principal are denied
  // by default. The cross-kind guard is the whole point of the
  // typed-subject model: `Subject::User("alice")` must not match
  // `Subject::Principal("alice")` even though their string ids
  // collide.
  return false;
}

// ── Instance model types ───────────────────────────────────────────────────

export type InstanceType = "principal";
export type InstanceStatus = "online" | "offline" | "busy" | "error";
export type InstanceExposure =
  | "local_only"
  | "private"
  | "public"
  | "public";

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
  ownerSubject: Subject | null;
  runtimeId: string;
  runtimeDisplayName: string | null;
  bundleRef: string | null;
  status: InstanceStatus;
  exposure: InstanceExposure;
  // Post-H4: the typed `allowedPrincipals` array is gone. The runtime
  // is the canonical ACL surface (R4); pekohub only knows the
  // public-vs-private exposure switch.
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

  // Transport preference for cross-runtime principal_send.

  // ADR-041: per-Principal DID, set by the runtime on
  // `instance_announce`. The by-hub-id resolver
  // (`GET /v1/principals/by-hub-id/:did`) hits the unique index on this
  // column. Nullable for pre-#82 peers; the by-hub-id endpoint 404s
  // when null.
  principalDid: string | null;
  hubId: string | null;
  localId: string | null;
  // ADR-058 D4: whether `principalDid` was proven via `principalPop`
  // on announce (did:key principals). False for legacy ids and rows
  // that predate the column.
  principalDidVerified: boolean;
}

export interface CreateInstanceInput {
  id?: string;
  type: InstanceType;
  name: string;
  ownerSubject?: Subject | null;
  runtimeId: string;
  runtimeDisplayName?: string;
  bundleRef?: string;
  status?: InstanceStatus;
  exposure?: InstanceExposure;
  // Post-H4: allowedPrincipals input — runtime owns ACLs.
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

  // Transport preference for cross-runtime principal_send.

  // ADR-041: per-Principal DID, set on `instance_announce`. Unique
  // when present.
  hubId?: string | null;
  localId?: string | null;
  principalDid?: string | null;
  // ADR-058 D4: PoP verification result for `principalDid`. Only
  // meaningful when `principalDid` is set on the same call; the
  // tunnel manager computes it — other callers should leave it
  // undefined.
  principalDidVerified?: boolean;
}

export interface UpdateInstanceInput {
  name?: string;
  runtimeDisplayName?: string;
  status?: InstanceStatus;
  exposure?: InstanceExposure;
  // Post-H4: allowedPrincipals update — runtime owns ACLs.
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

  // Transport preference for cross-runtime principal_send.

  // ADR-041: per-Principal DID. Set by the runtime on
  // `instance_announce` and re-keyed by the cross-runtime
  // `principal_send`
  // resolver ([peko-runtime#29]). Setting to `null` clears the column
  // (e.g. if a runtime downgrades to pre-#34).
  hubId?: string | null;
  localId?: string | null;
  // ADR-081 D4: the principal's owner (a Hub account), refreshed on every
  // announce so an owner transfer on the runtime reaches the directory.
  ownerSubject?: Subject;
  principalDid?: string | null;
  // ADR-058 D4: PoP verification result paired with `principalDid`.
  // `undefined` leaves the existing flag alone (same leave-alone
  // semantics as `principalDid`).
  principalDidVerified?: boolean;
}

export interface ListInstancesOptions {
  ownerSubject?: Subject;
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

export class AmbiguousPrincipalReference extends Error {
  constructor() { super("Principal handle is ambiguous; use its DID"); }
}

/** Route to the exposed host before private migration replicas. No implicit DB order. */
function resolutionOrder() {
  return [
    sql`CASE WHEN ${instances.exposure} IN ('public', 'public') THEN 0 ELSE 1 END`,
    desc(instances.principalDidVerified),
    sql`${instances.lastSeenAt} DESC NULLS LAST`,
    desc(instances.createdAt),
    desc(instances.id),
  ];
}

// ── Principal directory resolution (ADR-041, issue #14) ────────────────────

/**
 * The payload returned by `GET /v1/principals/by-hub-id/:did` and
 * `GET /v1/principals/by-handle/:owner/:principal_name` on a hit. This is the
 * minimum the runtime's cross-runtime `principal_send` needs to
 * dispatch: where to send, who the principal is, and what the
 * caller is allowed to assume about access (so the runtime can
 * decide whether to even attempt a tunnel open).
 */
export interface PrincipalTargetResolution {
  name: string;
  runtimeId: string;
  instanceId: string;
  principalDid: string;
  hubId: string;
  localId: string;
  identityKey: string;
  ownerSubject: Subject;
  exposure: InstanceExposure;
}

/**
 * Status of a directory lookup. Distinct from a boolean so the route
 * layer can return the right HTTP code (404 vs 403) without re-running
 * the access check.
 *
 *   - `hit`    → found, caller is allowed. Route returns 200.
 *   - `miss`   → not found (no row, or DID not set, or wrong owner/name).
 *                Route returns 404.
 *   - `denied` → found, but the caller fails `subjectCanAccess`.
 *                Route returns 403 — the existence-vs-permission
 *                distinction is preserved for legitimate callers per
 *                the issue's acceptance criteria.
 */
export type PrincipalTargetResolutionStatus = "hit" | "miss" | "denied" | "ambiguous";

export interface PrincipalTargetResolutionResult {
  status: PrincipalTargetResolutionStatus;
  resolution?: PrincipalTargetResolution;
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

// ── Defensive parser: wire → Subject (issue #11) ──────────────────────────

/**
 * Coerce a wire string (e.g. `"user:42"` or `"principal:helper"`)
 * into a `Subject`. Returns `null` if the string can't be parsed —
 * callers treat that as "ignore this entry" rather than throw, so a
 * single malformed entry doesn't poison the whole allow-list.
 */
function parseAllowEntry(s: string): Subject | null {
  return parseSubject(s);
}

// ── JSONB defensive parsers (issue #11 review #12 P1) ──────────────────────

/**
 * Validate a raw JSONB value from the `owner_subject` column through
 * the Zod schema. The column's TypeScript type is `Subject | null`
 * (Drizzle `$type` is a compile-time cast only — there is no runtime
 * check), so any garbage that lands in the column would otherwise flow
 * straight into `subjectCanAccess`. A `null`/missing JSONB returns
 * `null` (the "no owner asserted" case, which makes the row
 * ownerless per `resolveOwnerSubject`). Anything that doesn't match
 * the discriminated union returns `null` as well — the safe "ignore"
 * default, not the raw garbage.
 *
 * Exported for unit tests.
 */
export function parseSubjectJsonb(
  raw: unknown,
): Subject | null {
  if (raw === null || raw === undefined) return null;
  const result = Subject.safeParse(raw);
  return result.success ? result.data : null;
}

/**
 * Validate each entry of a raw JSONB value from the `allowed_principals`
 * column. Malformed entries are filtered out of the returned list
 * (rather than failing the whole row) so a single bad row in the
 * allow-list doesn't lock out a legitimate caller. The expected
 * column shape is `Subject[]`; a non-array value returns `[]`.
 *
 * Exported for unit tests.
 */
export function parseSubjectArrayJsonb(raw: unknown): Subject[] {
  if (!Array.isArray(raw)) return [];
  const out: Subject[] = [];
  for (const entry of raw) {
    const parsed = Subject.safeParse(entry);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

// ── Service ────────────────────────────────────────────────────────────────

/**
 * Instance management service.
 * Handles CRUD operations and tunnel-mediated proxying.
 */
export class InstanceService {
  // ── CRUD ───────────────────────────────────────────────────────────────────

  async create(input: CreateInstanceInput): Promise<InstanceRecord> {
    const [row] = await db
      .insert(instances)
      .values({
        id: input.id,
        type: input.type,
        name: input.name,
        ownerSubject: input.ownerSubject ?? null,
        runtimeId: input.runtimeId,
        runtimeDisplayName: input.runtimeDisplayName ?? null,
        bundleRef: input.bundleRef ?? null,
        status: input.status ?? "offline",
        exposure: input.exposure ?? "local_only",
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
        // Issue #14: only set when the caller supplies a value;
        // otherwise leave the column null so pre-#14 runtimes still
        // create valid rows. Drizzle treats `undefined` as "don't
        // include in the INSERT", so the default `null` from the
        // schema applies.
        hubId: input.hubId,
        localId: input.localId,
        principalDid: input.principalDid ?? undefined,
        // ADR-058 D4: PoP verification flag. `undefined` → schema
        // default (false).
        principalDidVerified: input.principalDidVerified ?? undefined,
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
      ownerSubject,
      runtimeId,
      status,
      type,
      exposure,
      page = 1,
      perPage = 20,
    } = options;

    const conditions: SQL[] = [];
    if (ownerSubject !== undefined) {
      // JSONB equality is exact-match — same kind + same id matches a
      // single owner. Post-H1 the typed `owner_subject` column is the
      // only owner source, so "list my instances as user X" filters
      // through here too.
      conditions.push(sql`${instances.ownerSubject} = ${JSON.stringify(ownerSubject)}::jsonb`);
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
    if (input.hubId !== undefined) values.hubId = input.hubId;
    if (input.localId !== undefined) values.localId = input.localId;
    if (input.ownerSubject !== undefined) values.ownerSubject = input.ownerSubject;
    if (input.principalDid !== undefined) values.principalDid = input.principalDid;
    if (input.principalDidVerified !== undefined)
      values.principalDidVerified = input.principalDidVerified;

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

  // ── Principal directory lookups (issue #14) ────────────────────────────────────

  /**
   * Look up an instance by its per-principal DID. The runtime sets this on
   * `instance_announce` (peko-runtime#34) and the cross-runtime
   * `principal_send` resolver uses it as its primary key
   * ([peko-runtime#29](https://github.com/ConekoAI/peko-runtime/issues/29)).
   *
   * Post-ADR-056-D7 the DID index is not unique (a transported
   * principal re-lands with the same DID under a new instance id);
   * Public/unlisted hosts take precedence over private replicas, followed
   * by proof of identity and freshness; the final id tie-break is stable. Returns `null` when no row matches. Caller
   * distinguishes via the helper {@link resolvePrincipalTarget} when
   * it also needs the access check.
   */
  async registerIdentity(signingDid: string, identityKey: string): Promise<string> {
    await db.insert(hubPrincipals).values({ signingDid, identityKey }).onConflictDoNothing();
    const actor = await db.query.hubPrincipals.findFirst({ where: eq(hubPrincipals.identityKey, identityKey) });
    if (!actor || actor.signingDid !== signingDid) throw new Error("Actor identity key belongs to another principal");
    return actor.id;
  }
  /**
   * ADR-081 D7: the instance a principal is linked to on a runtime other
   * than `runtimeId`, if any. A principal's Hub ID is online on one
   * runtime at a time.
   */
  async findLinkedElsewhere(hubId: string, runtimeId: string): Promise<InstanceRecord | null> {
    const row = await db.query.instances.findFirst({
      where: and(eq(instances.hubId, hubId), ne(instances.runtimeId, runtimeId)),
    });
    return row ? this.toRecord(row) : null;
  }

  /**
   * Where a signing identity may speak from (ADR-081 D7): `undefined` when
   * it is not a registered principal (receivers judge it end to end),
   * otherwise the runtime its online link points at, or `null` when it
   * is registered but online nowhere.
   */
  async linkedRuntimeForSigningDid(signingDid: string): Promise<string | null | undefined> {
    const actor = await db.query.hubPrincipals.findFirst({
      where: eq(hubPrincipals.signingDid, signingDid),
    });
    if (!actor) return undefined;
    const row = await db.query.instances.findFirst({ where: eq(instances.hubId, actor.id) });
    return row?.runtimeId ?? null;
  }

  /**
   * Record an owner's approval to link a principal to `runtimeId` (ADR-081
   * D4, D7). For an online principal only its recorded owner may approve
   * (a move). For one never online, any account may approve, but the
   * approval only admits a registration that names the approver as owner
   * — consent to own it. Lasts an hour and is used once.
   */
  async approveMove(hubId: string, runtimeId: string, approver: string): Promise<"approved" | "miss" | "denied"> {
    const current = await this.getByHubId(hubId);
    if (current) {
      if (current.ownerSubject?.kind !== "user" || current.ownerSubject.id !== approver) return "denied";
    } else if (!(await db.query.hubPrincipals.findFirst({ where: eq(hubPrincipals.id, hubId) }))) {
      return "miss";
    }
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await db
      .insert(principalMoveApprovals)
      .values({ hubId, runtimeId, approvedBy: approver, expiresAt })
      .onConflictDoUpdate({
        target: principalMoveApprovals.hubId,
        set: { runtimeId, approvedBy: approver, expiresAt },
      });
    return "approved";
  }

  /**
   * Transfer an online principal to `newOwner` (ADR-081 D4). The Hub's
   * record is the owner of an online principal, so only its current owner
   * account (`approver`) may transfer it, to an existing Hub user. Pending
   * link approvals by the previous owner are withdrawn.
   */
  async transferOwner(
    hubId: string,
    newOwner: string,
    approver: string,
  ): Promise<
    | { status: "transferred"; runtimeId: string; localId: string | null; previous: string }
    | { status: "miss" | "denied" | "unknown_user" }
  > {
    const current = await this.getByHubId(hubId);
    if (!current) return { status: "miss" };
    const previous = current.ownerSubject?.kind === "user" ? current.ownerSubject.id : null;
    if (previous === null || previous !== approver) return { status: "denied" };
    if (!(await db.query.users.findFirst({ where: eq(users.id, newOwner) }))) {
      return { status: "unknown_user" };
    }
    await db
      .update(instances)
      .set({ ownerSubject: { kind: "user", id: newOwner } })
      .where(eq(instances.id, current.id));
    await db.delete(principalMoveApprovals).where(eq(principalMoveApprovals.hubId, hubId));
    return { status: "transferred", runtimeId: current.runtimeId, localId: current.localId ?? null, previous };
  }

  /** Use an unexpired approval by `approver` to move `hubId` to `runtimeId`. */
  async consumeMoveApproval(hubId: string, runtimeId: string, approver: string): Promise<boolean> {
    const used = await db
      .delete(principalMoveApprovals)
      .where(
        and(
          eq(principalMoveApprovals.hubId, hubId),
          eq(principalMoveApprovals.runtimeId, runtimeId),
          eq(principalMoveApprovals.approvedBy, approver),
          gte(principalMoveApprovals.expiresAt, new Date()),
        ),
      )
      .returning({ hubId: principalMoveApprovals.hubId });
    return used.length > 0;
  }

  async getByHubId(id: string): Promise<InstanceRecord | null> {
    const row = await db.query.instances.findFirst({ where: eq(instances.hubId, id), orderBy: resolutionOrder() });
    return row ? this.toRecord(row) : null;
  }
  async getByDid(did: string): Promise<InstanceRecord | null> {
    const row = await db.query.instances.findFirst({
      where: eq(instances.principalDid, did),
      orderBy: resolutionOrder(),
    });
    return row ? this.toRecord(row) : null;
  }

  /**
   * ADR-056 D7: at most ONE publicly exposed (`public`/`unlisted`)
   * instance per principal DID network-wide. Returns the conflicting
   * instance when another row already holds the same `principal_did`
   * at a publicly reachable exposure, `null` when the transition is
   * free to proceed.
   *
   * `excludeId` is the instance requesting the transition (re-publication
   * of the already-public instance is idempotent, not a conflict).
   * The check is deliberately exposure-only: two runtimes may host
   * the same DID privately (e.g. a migration window), but only one
   * may serve it to the world.
   */
  async findPublicExposureConflict(
    principalDid: string,
    excludeId?: string,
  ): Promise<InstanceRecord | null> {
    const conditions = [
      eq(instances.principalDid, principalDid),
      eq(instances.exposure, "public"),
    ];
    if (excludeId) conditions.push(ne(instances.id, excludeId));
    const row = await db.query.instances.findFirst({
      where: and(...conditions),
    });
    return row ? this.toRecord(row) : null;
  }

  /**
   * Look up an instance by `{owner_namespace, principal_name}`. Used by
   * `GET /v1/principals/by-handle/:owner/:principal_name` and the
   * runtime-side client when the caller has only the human-readable
   * handle.
   *
   * v1 is user-namespace only. ADR-041 removed the Team subject
   * kind, so the team variant (removed in ADR-041) is intentionally not implemented.
   *
   * Returns `null` when either the owner namespace doesn't exist or
   * the owner has no instance with that name. The route layer
   * collapses those to 404; the access check then runs in
   * {@link resolvePrincipalTarget}.
   */
  async getByHandle(
    owner: string,
    principalName: string,
  ): Promise<InstanceRecord | null> {
    const ownerRow = await db.query.users.findFirst({
      where: eq(users.namespace, owner),
    });
    if (!ownerRow) return null;

    // Post-H1 the legacy `instances.owner_id` integer FK is gone; the
    // typed `owner_subject` JSONB is the source of truth. We match
    // exact JSONB equality using a string literal that mirrors the
    // runtime's `instance_announce` shape. Post-H3, `users.id` is a
    // UUID string but the `id` field in `owner_subject` is JSON-text
    // either way — `String(user.id)` covers both.
    const ownerSubjectLiteral = JSON.stringify({
      kind: "user",
      id: String(ownerRow.id),
    });
    const rows = await db.query.instances.findMany({
      where: and(
        sql`${instances.ownerSubject} = ${ownerSubjectLiteral}::jsonb`,
        eq(instances.name, principalName),
      ),
      orderBy: resolutionOrder(),
    });
    const registered = rows.filter(r => r.hubId && r.localId && r.exposure !== "local_only");
    const exposed = registered.filter(r => r.exposure === "public");
    const candidates = exposed.length > 0 ? exposed : registered;
    if (new Set(candidates.map(r => r.hubId ?? r.id)).size > 1) throw new AmbiguousPrincipalReference();
    return candidates[0] ? this.toRecord(candidates[0]) : null;
  }

  /**
   * Resolve a `TargetSpec` (by-hub-id or by-handle) into a host. The
   * cross-runtime `principal_send` ([peko-runtime#29]) calls this on the
   * hub to learn where to dispatch.
   *
   * The result carries an explicit status (`hit` / `miss` / `denied`)
   * so the route layer can pick the right HTTP code without
   * re-running the access check. This is the existence-vs-permission
   * distinction the issue's acceptance criteria require.
   *
   * `Public` exposure short-circuits the check (mirrors `canAccess`).
   * For non-public exposure, the resolved owner is gated by
   * `subjectCanAccess` — a `User` owner is a direct match. ADR-041
   * removed the Team subject kind, so only User and Principal
   * owners exist.
   */
  async resolvePrincipalTarget(
    spec: import("@pekohub/shared").TargetSpec,
    caller: CallerSubject,
  ): Promise<PrincipalTargetResolutionResult> {
    let instance: InstanceRecord | null;
    try {
      instance = spec.kind === "by-hub-id"
        ? await this.getByHubId(spec.hubId)
        : await this.getByHandle(spec.owner, spec.principalName);
    } catch (error) {
      if (error instanceof AmbiguousPrincipalReference) return { status: "ambiguous" };
      throw error;
    }

    if (!instance) {
      return { status: "miss" };
    }
    if (!instance.principalDid) {
      // A null principal_did shouldn't be reachable through the
      // by-hub-id resolver (the lookup is an equality match on a
      // non-null DID) — but the by-handle path can land here (e.g. a
      // pre-#34 runtime that announces without a principal_did). Treat
      // as miss for the by-hub-id path; the by-handle caller still gets
      // a meaningful hit (the by-handle wire format doesn't promise
      // a DID). We only return miss on by-hub-id.
      if (spec.kind === "by-hub-id") {
        return { status: "miss" };
      }
    }

    if (!instance.hubId || !instance.localId) return { status: "miss" };
    const actor = await db.query.hubPrincipals.findFirst({ where: eq(hubPrincipals.id, instance.hubId) });
    if (!actor) return { status: "miss" };
    const owner = resolveOwnerSubject(instance);
    // An ownerless row is the same as a miss for access purposes —
    // there's no principal to grant access, and a public exposure
    // would have been handled in `canAccess` at the call site if
    // the caller wanted to use it.
    if (owner === null) {
      return { status: "miss" };
    }

    if (instance.exposure === "local_only") return { status: "denied" };
    if (instance.exposure === "public" || (caller?.kind === "principal" || caller?.kind === "user") || (await subjectCanAccess(owner, caller))) {
      return {
        status: "hit",
        resolution: {
          runtimeId: instance.runtimeId,
          instanceId: instance.id,
          // The payload always includes the principal_did so the runtime
          // can echo it back to its own audit log. If the by-handle
          // path found a pre-#34 row with no DID, we report an empty
          // string (the runtime can use the handle as fallback).
          name: instance.name,
          hubId: instance.hubId,
          localId: instance.localId,
          identityKey: actor.identityKey,
          principalDid: instance.principalDid ?? "",
          ownerSubject: owner,
          exposure: instance.exposure,
        },
      };
    }

    return { status: "denied" };
  }

  async upsertFromAnnounce(
    input: CreateInstanceInput,
  ): Promise<InstanceRecord> {
    const existing = input.id ? await this.getById(input.id) : null;
    if (existing) {
      if (existing.runtimeId !== input.runtimeId || (existing.hubId && input.hubId && existing.hubId !== input.hubId)) {
        throw new Error("Instance identity cannot be reassigned to another runtime or actor");
      }
      const values: UpdateInstanceInput & { bundleRef?: string } = {
        name: input.name,
        runtimeDisplayName: input.runtimeDisplayName,
        status: input.status,
        exposure: input.exposure,
        capabilities: input.capabilities,
        metadata: input.metadata,
      };
      if (input.bundleRef !== undefined) values.bundleRef = input.bundleRef;
      // ADR-041: persist the per-Principal DID on re-announce. Treat
      // `undefined` (pre-#82 runtime that doesn't send the field)
      // as "leave the existing value alone" — otherwise a downgrade
      // would silently clear the column.
      if (input.hubId !== undefined) values.hubId = input.hubId;
    if (input.localId !== undefined) values.localId = input.localId;
    if (input.ownerSubject) values.ownerSubject = input.ownerSubject;
    if (input.principalDid !== undefined) values.principalDid = input.principalDid;
      // ADR-058 D4: the verified flag travels with the DID — the
      // tunnel manager recomputes it on every announce that carries
      // a `principalDid`, so a re-announce that fails PoP never
      // leaves a stale `verified: true` behind (it rejects the whole
      // announce instead).
      if (input.principalDidVerified !== undefined)
        values.principalDidVerified = input.principalDidVerified;
      // Persist the per-Principal transport preference on re-announce.
      // Treat `undefined` as "leave the existing value alone".
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
   * 4. Otherwise → denied.
   *
   * Post-H4: the typed `allowedPrincipals` allow-list is gone. The
   * runtime's `PrincipalConfig.permissions` is the only ACL surface
   * (R4); pekohub only knows the public-vs-private exposure switch.
   */
  async canAccess(
    instance: InstanceRecord,
    caller: CallerSubject | string | null,
  ): Promise<boolean> {
    if (instance.exposure === "public") return true;

    const c = normalizeCaller(caller);
    if (c === null) return false;

    const owner = resolveOwnerSubject(instance);
    if (owner && (await subjectCanAccess(owner, c))) return true;

    return false;
  }

  /**
   * True if `caller` can chat with this instance (POST /v1/instances/:id/chat
   * and GET /v1/instances/:id/stream).
   *
   * `canAccess` + the same offline / unexposed / public gates.
   * Unexposed and offline instances deny even owners; public allows
   * anonymous.
   *
   * Post-H4: see canAccess — the runtime owns the allow-list
   * (`PrincipalConfig.permissions`), not pekohub.
   */
  async canChat(
    instance: InstanceRecord,
    caller: CallerSubject | string | null,
  ): Promise<boolean> {
    if (instance.status === "offline" || instance.exposure === "local_only") {
      return false;
    }
    // `public` and `unlisted` are both reachable via the public URL —
    // pekohub only forwards the request; the runtime runs the
    // defense-in-depth ACL in `check_request_allowed`. Discovery
    // remains strictly `public` only.
    if (instance.exposure === "public") {
      return true;
    }

    const c = normalizeCaller(caller);
    if (c === null) return false;

    // Hub registration ownership governs administration. The recipient runtime
    // owns chat grants, including grants to accounts other than the registrar.
    if (resolveOwnerSubject(instance) === null) return false;
    return c.kind === "user" || c.kind === "principal";
  }

  /**
   * True if `caller` is the resolved owner of `instance`. This is the
   * issue #11 replacement for the legacy `owner_id !== user.id` check
   * at the owner-check sites in `routes/api/instances.ts`. Returns
   * `false` if the instance has no resolvable owner.
   */
  async isOwner(
    instance: InstanceRecord,
    caller: CallerSubject | string | null,
  ): Promise<boolean> {
    const owner = resolveOwnerSubject(instance);
    if (owner === null) return false;
    const c = normalizeCaller(caller);
    if (c === null) return false;
    return subjectCanAccess(owner, c);
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
      // Issue #11 review #12 P1: validate the JSONB columns through
      // Zod so a malformed row (e.g. `{"kind": "user", "id": null}`
      // from a future migration bug, a manual psql edit, or a backfill
      // that goes wrong) cannot flow through unchecked into
      // `subjectCanAccess` — where `null === null` would silently
      // grant access. A malformed owner drops to `null`, leaving the
      // row ownerless (per `resolveOwnerSubject`).
      ownerSubject: parseSubjectJsonb(row.ownerSubject),
      runtimeId: row.runtimeId,
      runtimeDisplayName: row.runtimeDisplayName,
      bundleRef: row.bundleRef,
      status: row.status as InstanceStatus,
      exposure: row.exposure as InstanceExposure,
      // Post-H4: allowedPrincipals is gone. The runtime owns the
      // ACL surface (R4); pekohub only knows public-vs-private
      // exposure.
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
      // ADR-041: per-Principal DID from `instance_announce`.
      hubId: row.hubId ?? null,
      localId: row.localId ?? null,
      principalDid: row.principalDid ?? null,
      // ADR-058 D4: PoP verification flag for `principalDid`.
      principalDidVerified: row.principalDidVerified ?? false,
    };
  }
}

// ── Caller normalization shim (back-compat) ────────────────────────────────

/**
 * Coerce the various caller shapes callers pass in to a unified
 * `CallerSubject`. Accepts:
 *
 * - `null` → null (unauthenticated)
 * - `string` → `Subject::User(s)` (the post-H3 UUID `userId` shape
 *   from the auth plugin)
 * - `Subject` → as-is
 *
 * The legacy `number` shape is gone post-H3 — `users.id` is a UUID
 * string on both sides.
 */
function normalizeCaller(
  caller: CallerSubject | string | null,
): CallerSubject {
  if (caller === null || caller === undefined) return null;
  if (typeof caller === "string") {
    return { kind: "user", id: caller };
  }
  return caller;
}

// Re-export the wire-format helper for use by route handlers that
// parse legacy `allowedPrincipals` strings (the runtime may still send
// bare user ids in the `allowed_principals` field of an announce).
export { parseAllowEntry as _parseAllowEntry };

export const instanceService = new InstanceService();
