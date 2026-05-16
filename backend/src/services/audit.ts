import { db } from '../db/index.js';
import { auditLogs, users } from '../db/schema.js';
import { eq, and, desc, sql, count } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';

export interface ListAuditOptions {
  action?: string;
  page?: number;
  perPage?: number;
}

export interface ListAuditResult {
  logs: {
    id: number;
    namespace: string;
    userId: number | null;
    action: string;
    resource: string;
    details: unknown;
    createdAt: Date;
  }[];
  total: number;
  page: number;
  perPage: number;
}

/**
 * Audit logging service.
 * All log methods are fire-and-forget: they catch and suppress errors
 * so that audit failures never crash a request.
 */
export class AuditService {
  private logError(method: string, err: unknown): void {
    // eslint-disable-next-line no-console
    console.error(`[AuditService] ${method} failed:`, err instanceof Error ? err.message : String(err));
  }

  async logPush(
    namespace: string,
    userId: number | undefined,
    bundleName: string,
    version: string,
    digest: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await db.insert(auditLogs).values({
        namespace,
        userId: userId ?? null,
        action: 'push',
        resource: `${namespace}/${bundleName}:${version}`,
        details: { digest, ...details },
      });
    } catch (err) {
      this.logError('logPush', err);
    }
  }

  async logPull(
    namespace: string,
    userId: number | undefined,
    bundleName: string,
    version: string,
    digest: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await db.insert(auditLogs).values({
        namespace,
        userId: userId ?? null,
        action: 'pull',
        resource: `${namespace}/${bundleName}:${version}`,
        details: { digest, ...details },
      });
    } catch (err) {
      this.logError('logPull', err);
    }
  }

  async logDelete(
    namespace: string,
    userId: number | undefined,
    bundleName: string,
    version: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await db.insert(auditLogs).values({
        namespace,
        userId: userId ?? null,
        action: 'delete',
        resource: `${namespace}/${bundleName}:${version}`,
        details: details ?? null,
      });
    } catch (err) {
      this.logError('logDelete', err);
    }
  }

  async logPermissionChange(
    namespace: string,
    userId: number | undefined,
    resource: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await db.insert(auditLogs).values({
        namespace,
        userId: userId ?? null,
        action: 'permission_change',
        resource,
        details: details ?? null,
      });
    } catch (err) {
      this.logError('logPermissionChange', err);
    }
  }

  async listByNamespace(
    namespace: string,
    options: ListAuditOptions = {},
  ): Promise<ListAuditResult> {
    const { action, page = 1, perPage = 20 } = options;

    const conditions: SQL[] = [eq(auditLogs.namespace, namespace)];
    if (action) {
      conditions.push(eq(auditLogs.action, action));
    }

    const whereClause = and(...conditions);

    const [logs, totalResult] = await Promise.all([
      db
        .select()
        .from(auditLogs)
        .where(whereClause)
        .orderBy(desc(auditLogs.createdAt))
        .limit(perPage)
        .offset((page - 1) * perPage),
      db
        .select({ count: count() })
        .from(auditLogs)
        .where(whereClause),
    ]);

    return {
      logs: logs.map((log) => ({
        id: log.id,
        namespace: log.namespace,
        userId: log.userId ?? null,
        action: log.action,
        resource: log.resource,
        details: log.details,
        createdAt: log.createdAt,
      })),
      total: totalResult[0]?.count ?? 0,
      page,
      perPage,
    };
  }
}

export const auditService = new AuditService();
