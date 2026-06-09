import { db } from '../db/index.js';
import { instances } from '../db/schema.js';
import { eq, and, sql, desc, count, gte, lt } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';

export type InstanceType = 'agent' | 'team';
export type InstanceStatus = 'online' | 'offline' | 'busy' | 'error';
export type InstanceExposure = 'unexposed' | 'private' | 'public';

export type PublicCategory =
  | 'productivity'
  | 'coding'
  | 'creative'
  | 'business'
  | 'entertainment'
  | 'education'
  | 'other';

export interface InstanceRecord {
  id: string;
  type: InstanceType;
  name: string;
  ownerId: number;
  runtimeId: string;
  runtimeDisplayName: string | null;
  bundleRef: string | null;
  status: InstanceStatus;
  exposure: InstanceExposure;
  allowedUsers: string[];
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
    pricingModel: 'free' | 'subscription' | 'usage' | null;
    priceCents: number | null;
    stripeProductId: string | null;
  };
}

export interface CreateInstanceInput {
  id?: string;
  type: InstanceType;
  name: string;
  ownerId: number;
  runtimeId: string;
  runtimeDisplayName?: string;
  bundleRef?: string;
  status?: InstanceStatus;
  exposure?: InstanceExposure;
  allowedUsers?: string[];
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
  method: 'chat' | 'stream';
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
        ownerId: input.ownerId,
        runtimeId: input.runtimeId,
        runtimeDisplayName: input.runtimeDisplayName ?? null,
        bundleRef: input.bundleRef ?? null,
        status: input.status ?? 'offline',
        exposure: input.exposure ?? 'unexposed',
        allowedUsers: input.allowedUsers ?? [],
        capabilities: input.capabilities ?? [],
        metadata: input.metadata ?? {},
        lastSeenAt: input.status === 'online' ? new Date() : null,
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
    const { ownerId, runtimeId, status, type, exposure, page = 1, perPage = 20 } = options;

    const conditions: SQL[] = [];
    if (ownerId !== undefined) conditions.push(eq(instances.ownerId, ownerId));
    if (runtimeId !== undefined) conditions.push(eq(instances.runtimeId, runtimeId));
    if (status !== undefined) conditions.push(eq(instances.status, status));
    if (type !== undefined) conditions.push(eq(instances.type, type));
    if (exposure !== undefined) conditions.push(eq(instances.exposure, exposure));

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

  async update(id: string, input: UpdateInstanceInput): Promise<InstanceRecord | null> {
    const values: Record<string, unknown> = {};
    if (input.name !== undefined) values.name = input.name;
    if (input.runtimeDisplayName !== undefined) values.runtimeDisplayName = input.runtimeDisplayName;
    if (input.status !== undefined) {
      values.status = input.status;
      if (input.status === 'online' || input.status === 'busy' || input.status === 'error') {
        values.lastSeenAt = new Date();
      }
    }
    if (input.exposure !== undefined) values.exposure = input.exposure;
    if (input.allowedUsers !== undefined) values.allowedUsers = input.allowedUsers;
    if (input.capabilities !== undefined) values.capabilities = input.capabilities;
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
    const result = await db.delete(instances).where(eq(instances.id, id)).returning();
    return result.length > 0;
  }

  async upsertFromAnnounce(input: CreateInstanceInput): Promise<InstanceRecord> {
    const existing = input.id ? await this.getById(input.id) : null;
    if (existing) {
      const values: UpdateInstanceInput & { bundleRef?: string } = {
        name: input.name,
        runtimeDisplayName: input.runtimeDisplayName,
        status: input.status,
        exposure: input.exposure,
        allowedUsers: input.allowedUsers,
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
      .set({ status: 'offline' })
      .where(and(eq(instances.status, 'online'), lt(instances.lastSeenAt, cutoff)))
      .returning({ id: instances.id });
    return result.length;
  }

  // ── Permissions ────────────────────────────────────────────────────────────

  canAccess(instance: InstanceRecord, userId: number | null): boolean {
    if (instance.exposure === 'public') return true;
    if (userId === null) return false;
    if (instance.ownerId === userId) return true;
    return instance.allowedUsers.some((u) => String(u) === String(userId));
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private toRecord(row: typeof instances.$inferSelect): InstanceRecord {
    const monetization = (row.monetization as Record<string, unknown> | null) ?? {
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
      runtimeId: row.runtimeId,
      runtimeDisplayName: row.runtimeDisplayName,
      bundleRef: row.bundleRef,
      status: row.status as InstanceStatus,
      exposure: row.exposure as InstanceExposure,
      allowedUsers: (row.allowedUsers as string[]) ?? [],
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
        pricingModel: (monetization.pricingModel as 'free' | 'subscription' | 'usage' | null) ?? null,
        priceCents: (monetization.priceCents as number | null) ?? null,
        stripeProductId: (monetization.stripeProductId as string | null) ?? null,
      },
    };
  }
}

export const instanceService = new InstanceService();
