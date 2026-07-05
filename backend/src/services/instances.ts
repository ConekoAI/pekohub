import { db } from "../db/index.js";
import { instances, runtimes, users } from "../db/schema.js";
import { eq, and, sql, desc, count, gte, lt } from "drizzle-orm";
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
 * Three cases, in order of preference:
 *
 * 1. `instance.ownerSubject` is set and is not the empty sentinel
 *    `Subject::User("")` → use it.
 * 2. Otherwise, fall back to `Subject::User(instance.ownerId)`. This
 *    covers both pre-#11 rows (no `owner_subject` column at all) and
 *    post-#11 rows that were backfilled by the runtime migration with
 *    the empty sentinel
 *    ([peko-runtime/src/runtime/migration.rs:170-171, 234-235]).
 * 3. If even `ownerId` is null, return `null` (truly ownerless row).
 */
export function resolveOwnerSubject(
  instance: Pick<InstanceRecord, "ownerId" | "ownerSubject">,
): Subject | null {
  if (
    instance.ownerSubject &&
    !isEmptyOwnerSubject(instance.ownerSubject)
  ) {
    return instance.ownerSubject;
  }
  if (instance.ownerId) {
    return { kind: "user", id: String(instance.ownerId) };
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

// ── Allow-list check (matches a caller against instance.allow) ──────────────

/**
 * True if `caller` matches the instance's typed `allowedPrincipals`
 * allow-list.
 *
 * Public-kind callers are never on an allow-list (public access goes
 * through `instance.exposure === "public"` at a higher level).
 */
function principalInAllowList(
  instance: Pick<InstanceRecord, "allowedPrincipals">,
  caller: CallerSubject,
): boolean {
  if (caller === null) return false;
  if (caller.kind === "public") return false;
  return instance.allowedPrincipals.some(
    (p) => p.kind === caller.kind && p.id === caller.id,
  );
}

// ── Instance model types ───────────────────────────────────────────────────

export type InstanceType = "principal";
export type InstanceStatus = "online" | "offline" | "busy" | "error";
export type InstanceExposure = "unexposed" | "private" | "public";
export type TransportPreference = "auto" | "tunnel" | "direct";

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
  ownerSubject: Subject | null;
  runtimeId: string;
  runtimeDisplayName: string | null;
  bundleRef: string | null;
  status: InstanceStatus;
  exposure: InstanceExposure;
  allowedPrincipals: Subject[];
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
  transportPreference: TransportPreference;

  // ADR-041: per-Principal DID, set by the runtime on
  // `instance_announce`. The by-did resolver
  // (`GET /v1/principals/by-did/:did`) hits the unique index on this
  // column. Nullable for pre-#82 peers; the by-did endpoint 404s
  // when null.
  principalDid: string | null;
}

export interface CreateInstanceInput {
  id?: string;
  type: InstanceType;
  name: string;
  ownerId: number;
  ownerSubject?: Subject | null;
  runtimeId: string;
  runtimeDisplayName?: string;
  bundleRef?: string;
  status?: InstanceStatus;
  exposure?: InstanceExposure;
  allowedPrincipals?: Subject[];
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
  transportPreference?: TransportPreference;

  // ADR-041: per-Principal DID, set on `instance_announce`. Unique
  // when present.
  principalDid?: string | null;
}

export interface UpdateInstanceInput {
  name?: string;
  runtimeDisplayName?: string;
  status?: InstanceStatus;
  exposure?: InstanceExposure;
  allowedPrincipals?: Subject[];
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
  transportPreference?: TransportPreference;

  // ADR-041: per-Principal DID. Set by the runtime on
  // `instance_announce` and re-keyed by the cross-runtime
  // `principal_send`
  // resolver ([peko-runtime#29]). Setting to `null` clears the column
  // (e.g. if a runtime downgrades to pre-#34).
  principalDid?: string | null;
}

export interface ListInstancesOptions {
  ownerId?: number;
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

// ── Principal directory resolution (ADR-041, issue #14) ────────────────────

/**
 * The payload returned by `GET /v1/principals/by-did/:did` and
 * `GET /v1/principals/by-handle/:owner/:principal_name` on a hit. This is the
 * minimum the runtime's cross-runtime `principal_send` needs to
 * dispatch: where to send, who the principal is, and what the
 * caller is allowed to assume about access (so the runtime can
 * decide whether to even attempt a tunnel open).
 */
export interface PrincipalTargetResolution {
  runtimeId: string;
  instanceId: string;
  principalDid: string;
  ownerSubject: Subject;
  exposure: InstanceExposure;
  transportPreference: TransportPreference;
  directEndpoint: string | null;
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
export type PrincipalTargetResolutionStatus = "hit" | "miss" | "denied";

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
 * `null` (the "no owner asserted" case, which is then backfilled from
 * the legacy `ownerId` by `resolveOwnerSubject`). Anything that
 * doesn't match the discriminated union returns `null` as well — the
 * safe "ignore" default, not the raw garbage.
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
    // Resolve ownerSubject: prefer the input, otherwise backfill from
    // the legacy ownerId.
    const ownerSubject =
      input.ownerSubject !== undefined
        ? input.ownerSubject
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
        ownerSubject,
        runtimeId: input.runtimeId,
        runtimeDisplayName: input.runtimeDisplayName ?? null,
        bundleRef: input.bundleRef ?? null,
        status: input.status ?? "offline",
        exposure: input.exposure ?? "unexposed",
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
        // Issue #14: only set when the caller supplies a value;
        // otherwise leave the column null so pre-#14 runtimes still
        // create valid rows. Drizzle treats `undefined` as "don't
        // include in the INSERT", so the default `null` from the
        // schema applies.
        principalDid: input.principalDid ?? undefined,
        transportPreference: input.transportPreference ?? undefined,
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
      ownerSubject,
      runtimeId,
      status,
      type,
      exposure,
      page = 1,
      perPage = 20,
    } = options;

    const conditions: SQL[] = [];
    if (ownerId !== undefined) conditions.push(eq(instances.ownerId, ownerId));
    if (ownerSubject !== undefined) {
      // JSONB equality is exact-match. For "list my instances as user X"
      // we use the legacy `ownerId` column (numeric FK). The principal
      // filter is for the typed case (e.g. list all Principal-owned
      // instances for a given principal id).
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
    if (input.principalDid !== undefined) values.principalDid = input.principalDid;
    if (input.transportPreference !== undefined)
      values.transportPreference = input.transportPreference;

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

  // ── Agent directory lookups (issue #14) ────────────────────────────────────

  /**
   * Look up an instance by its per-principal DID. The runtime sets this on
   * `instance_announce` (peko-runtime#34) and the cross-runtime
   * `a2a_send` resolver uses it as its primary key
   * ([peko-runtime#29](https://github.com/ConekoAI/peko-runtime/issues/29)).
   *
   * Hits the `idx_instances_principal_did` unique index — single
   * row, regardless of how many instances exist. Returns `null`
   * when the row exists but the DID is null (shouldn't happen with
   * the unique index, but the type system is permissive), and
   * `null` when no row matches. Caller distinguishes via the helper
   * {@link resolvePrincipalTarget} when it also needs the access check.
   */
  async getByDid(did: string): Promise<InstanceRecord | null> {
    const row = await db.query.instances.findFirst({
      where: eq(instances.principalDid, did),
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
   * kind, so the team branch is intentionally not implemented.
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

    const row = await db.query.instances.findFirst({
      where: and(
        eq(instances.ownerId, ownerRow.id),
        eq(instances.name, principalName),
      ),
    });
    return row ? this.toRecord(row) : null;
  }

  /**
   * Resolve a `TargetSpec` (by-did or by-handle) into a host. The
   * cross-runtime `a2a_send` ([peko-runtime#29]) calls this on the
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
    const instance =
      spec.kind === "by-did"
        ? await this.getByDid(spec.did)
        : await this.getByHandle(spec.owner, spec.principalName);

    if (!instance) {
      return { status: "miss" };
    }
    if (!instance.principalDid) {
      // The unique index treats nulls as distinct, so a row with a
      // null principal_did shouldn't be reachable through the by-did
      // resolver — but the by-handle path can land here (e.g. a
      // pre-#34 runtime that announces without an principal_did). Treat
      // as miss for the by-did path; the by-handle caller still gets
      // a meaningful hit (the by-handle wire format doesn't promise
      // a DID). We only return miss on by-did.
      if (spec.kind === "by-did") {
        return { status: "miss" };
      }
    }

    const owner = resolveOwnerSubject(instance);
    // An ownerless row is the same as a miss for access purposes —
    // there's no principal to grant access, and a public exposure
    // would have been handled in `canAccess` at the call site if
    // the caller wanted to use it.
    if (owner === null) {
      return { status: "miss" };
    }

    if (instance.exposure === "public" || (await subjectCanAccess(owner, caller))) {
      const runtime = await db.query.runtimes.findFirst({
        where: eq(runtimes.runtimeDid, instance.runtimeId),
        columns: { directEndpoint: true },
      });
      return {
        status: "hit",
        resolution: {
          runtimeId: instance.runtimeId,
          instanceId: instance.id,
          // The payload always includes the principal_did so the runtime
          // can echo it back to its own audit log. If the by-handle
          // path found a pre-#34 row with no DID, we report an empty
          // string (the runtime can use the handle as fallback).
          principalDid: instance.principalDid ?? "",
          ownerSubject: owner,
          exposure: instance.exposure,
          transportPreference: instance.transportPreference ?? "auto",
          directEndpoint: runtime?.directEndpoint ?? null,
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
      const values: UpdateInstanceInput & { bundleRef?: string } = {
        name: input.name,
        runtimeDisplayName: input.runtimeDisplayName,
        status: input.status,
        exposure: input.exposure,
        allowedPrincipals: input.allowedPrincipals,
        capabilities: input.capabilities,
        metadata: input.metadata,
      };
      if (input.bundleRef !== undefined) values.bundleRef = input.bundleRef;
      // ADR-041: persist the per-Principal DID on re-announce. Treat
      // `undefined` (pre-#82 runtime that doesn't send the field)
      // as "leave the existing value alone" — otherwise a downgrade
      // would silently clear the column.
      if (input.principalDid !== undefined) values.principalDid = input.principalDid;
      // Persist the per-Principal transport preference on re-announce.
      // Treat `undefined` as "leave the existing value alone".
      if (input.transportPreference !== undefined) values.transportPreference = input.transportPreference;
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
   *    `allowedPrincipals`) → allowed.
   * 5. Otherwise → denied.
   */
  async canAccess(
    instance: InstanceRecord,
    caller: CallerSubject | number | null,
  ): Promise<boolean> {
    if (instance.exposure === "public") return true;

    const c = normalizeCaller(caller);
    if (c === null) return false;

    const owner = resolveOwnerSubject(instance);
    if (owner && (await subjectCanAccess(owner, c))) return true;

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
    caller: CallerSubject | number | null,
  ): Promise<boolean> {
    if (instance.status === "offline" || instance.exposure === "unexposed") {
      return false;
    }
    if (instance.exposure === "public") return true;

    const c = normalizeCaller(caller);
    if (c === null) return false;

    const owner = resolveOwnerSubject(instance);
    if (owner && (await subjectCanAccess(owner, c))) return true;

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
    caller: CallerSubject | number | null,
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
      ownerId: row.ownerId,
      // Issue #11 review #12 P1: validate the JSONB columns through
      // Zod so a malformed row (e.g. `{"kind": "user", "id": null}`
      // from a future migration bug, a manual psql edit, or a backfill
      // that goes wrong) cannot flow through unchecked into
      // `subjectCanAccess` — where `null === null` would silently
      // grant access. A malformed owner drops to `null` (which makes
      // the row ownerless and triggers the legacy `ownerId`
      // backfill in `resolveOwnerSubject`). A malformed allow-list
      // entry is filtered out of `allowedPrincipals`.
      ownerSubject: parseSubjectJsonb(row.ownerSubject),
      runtimeId: row.runtimeId,
      runtimeDisplayName: row.runtimeDisplayName,
      bundleRef: row.bundleRef,
      status: row.status as InstanceStatus,
      exposure: row.exposure as InstanceExposure,
      allowedPrincipals: parseSubjectArrayJsonb(row.allowedPrincipals),
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
      principalDid: row.principalDid ?? null,
      transportPreference:
        (row.transportPreference as TransportPreference | null) ?? "auto",
    };
  }
}

// ── Caller normalization shim (back-compat) ────────────────────────────────

/**
 * Coerce the various caller shapes callers pass in to a unified
 * `CallerSubject`. Accepts:
 *
 * - `null` → null (unauthenticated)
 * - `number` → `Principal::User(String(n))` (the legacy `userId: number`
 *   shape from the auth plugin)
 * - `Principal` → as-is
 */
function normalizeCaller(
  caller: CallerSubject | number | null,
): CallerSubject {
  if (caller === null || caller === undefined) return null;
  if (typeof caller === "number") {
    return { kind: "user", id: String(caller) };
  }
  return caller;
}

// Re-export the wire-format helper for use by route handlers that
// parse legacy `allowedPrincipals` strings (the runtime may still send
// bare user ids in the `allowed_principals` field of an announce).
export { parseAllowEntry as _parseAllowEntry };

export const instanceService = new InstanceService();
