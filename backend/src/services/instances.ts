import { db } from '../db/index.js';
import { instances, users } from '../db/schema.js';
import { eq, and, sql, desc, count, gte, lt } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';

export type InstanceType = 'agent' | 'team';
export type InstanceStatus = 'online' | 'offline' | 'busy' | 'error';
export type InstanceExposure = 'private' | 'public' | 'unexposed';

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
}

export interface UpdateInstanceInput {
  name?: string;
  runtimeDisplayName?: string;
  status?: InstanceStatus;
  exposure?: InstanceExposure;
  allowedUsers?: string[];
  capabilities?: string[];
  metadata?: Record<string, unknown>;
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
 * In-memory registry for pending proxied requests.
 * Maps requestId -> { resolve, reject, reply }
 */
const pendingRequests = new Map<
  string,
  {
    resolve: (value: { status: number; body: unknown }) => void;
    reject: (reason: Error) => void;
    reply?: unknown;
  }
>();

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

  // ── Tunnel Proxy ───────────────────────────────────────────────────────────

  async sendProxiedRequest(
    runtimeId: string,
    payload: ProxiedRequestPayload,
    timeoutMs: number = 30_000
  ): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve, reject) => {
      pendingRequests.set(payload.requestId, { resolve, reject });

      // TODO: Integrate with actual tunnel manager to send `proxied_request` message
      // For now, the tunnel manager should call `resolveProxiedResponse` when a
      // `proxied_response` or `stream_chunk` (with done=true) arrives.

      // Timeout safeguard
      const timer = setTimeout(() => {
        if (pendingRequests.has(payload.requestId)) {
          pendingRequests.delete(payload.requestId);
          reject(new Error('Proxy request timeout'));
        }
      }, timeoutMs);

      // Ensure timer doesn't keep the process alive in tests
      if (timer.unref) {
        timer.unref();
      }
    });
  }

  resolveProxiedResponse(requestId: string, status: number, body: unknown): void {
    const pending = pendingRequests.get(requestId);
    if (pending) {
      pendingRequests.delete(requestId);
      pending.resolve({ status, body });
    }
  }

  rejectProxiedRequest(requestId: string, error: Error): void {
    const pending = pendingRequests.get(requestId);
    if (pending) {
      pendingRequests.delete(requestId);
      pending.reject(error);
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private toRecord(row: typeof instances.$inferSelect): InstanceRecord {
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
    };
  }
}

export const instanceService = new InstanceService();
