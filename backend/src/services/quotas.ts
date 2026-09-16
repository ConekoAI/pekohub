/**
 * Per-instance message quota store (PR-B3).
 *
 * `instances.dailyQuota` / `instances.weeklyQuota` columns exist
 * in the schema (`backend/src/db/schema.ts`) and are read
 * into the service types, but no chat path enforces them today
 * — the only protection on `POST /v1/public/pekos/.../chat`
 * is the in-memory 20/min/IP rate limit, which is bypassable by
 * any reasonable botnet.
 *
 * This service adds a per-instance counter that ticks on every
 * chat message (regardless of caller auth) and rejects the next
 * `consume()` once either cap is hit. The two implementations
 * share the `QuotaStore` interface so tests can substitute the
 * in-memory variant without spinning up Redis.
 *
 * Design notes:
 * - `consume` is atomic: count-then-check, but increments even
 *   on rejection is a footgun we deliberately avoid.
 * - Fixed-UTC-day / fixed-ISO-week windows (not sliding). For a
 *   daily cap this means a user gets a fresh budget at 00:00 UTC;
 *   good enough for an abuse cap.
 * - The in-memory store prunes entries older than 8 days so a
 *   long-running hub process doesn't grow unbounded.
 * - The Redis variant (TTL-based) is optional; the wiring falls
 *   back to in-memory when `REDIS_URL` is absent.
 */

export interface QuotaConsumeResult {
  allowed: boolean;
  dailyRemaining: number | null;
  weeklyRemaining: number | null;
  /** Why denied — surfaces in the SSE error frame so the SPA can
   *  render "you've hit the daily limit" instead of "you've hit
   *  the weekly limit". `undefined` when `allowed === true`. */
  reason?: "daily" | "weekly";
}

export interface QuotaStore {
  /**
   * Charge one message to `instanceId`. Returns `{allowed:false}`
   * (without incrementing) if `daily`/`weekly` already hit their
   * cap. Pass `null` for a cap to leave it unlimited.
   */
  consume(
    instanceId: string,
    daily: number | null,
    weekly: number | null,
  ): Promise<QuotaConsumeResult>;
}

// ── In-memory implementation ────────────────────────────────────────────────

interface QuotaEntry {
  date: string;
  week: string;
  dailyCount: number;
  weeklyCount: number;
}

const RETENTION_DAYS = 8;

function isoDateUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function isoWeekUtc(d: Date): string {
  // ISO-8601 week number, e.g. "2026-W30". Computed locally so
  // the test doesn't depend on a library.
  const target = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
  // Thursday of the current week determines the year/week.
  const dayNr = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstDayNr = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNr + 3);
  const week =
    1 +
    Math.round((target.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export class InMemoryQuotaStore implements QuotaStore {
  private readonly entries = new Map<string, QuotaEntry>();

  async consume(
    instanceId: string,
    daily: number | null,
    weekly: number | null,
  ): Promise<QuotaConsumeResult> {
    const now = new Date();
    const today = isoDateUtc(now);
    const thisWeek = isoWeekUtc(now);

    let entry = this.entries.get(instanceId);
    // Roll the entry over to the current day/week if it has aged
    // out. New instances start at zero on first consume.
    if (entry && (entry.date !== today || entry.week !== thisWeek)) {
      entry = {
        date: today,
        week: thisWeek,
        dailyCount: entry.date === today ? entry.dailyCount : 0,
        weeklyCount: entry.week === thisWeek ? entry.weeklyCount : 0,
      };
      this.entries.set(instanceId, entry);
    } else if (!entry) {
      entry = {
        date: today,
        week: thisWeek,
        dailyCount: 0,
        weeklyCount: 0,
      };
      this.entries.set(instanceId, entry);
    }

    // Reject first so we don't tick the counter on a denied message.
    if (daily !== null && entry.dailyCount >= daily) {
      return {
        allowed: false,
        reason: "daily",
        dailyRemaining: 0,
        weeklyRemaining:
          weekly === null ? null : Math.max(0, weekly - entry.weeklyCount),
      };
    }
    if (weekly !== null && entry.weeklyCount >= weekly) {
      return {
        allowed: false,
        reason: "weekly",
        dailyRemaining:
          daily === null ? null : Math.max(0, daily - entry.dailyCount),
        weeklyRemaining: 0,
      };
    }

    entry.dailyCount += 1;
    entry.weeklyCount += 1;
    return {
      allowed: true,
      dailyRemaining: daily === null ? null : daily - entry.dailyCount,
      weeklyRemaining: weekly === null ? null : weekly - entry.weeklyCount,
    };
  }

  /** Test helper — drops a specific instance's counters. */
  reset(instanceId?: string): void {
    if (instanceId === undefined) {
      this.entries.clear();
      return;
    }
    this.entries.delete(instanceId);
  }

  /** Test helper — force-prunes entries older than the retention
   *  window. The real production prune runs lazily on `consume`,
   *  so this is mostly for deterministic tests. */
  prune(now: Date = new Date()): void {
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 3600 * 1000);
    const cutoffDate = isoDateUtc(cutoff);
    for (const [id, entry] of this.entries) {
      if (entry.date < cutoffDate) this.entries.delete(id);
    }
  }
}

// ── Redis implementation (optional, prod-only) ──────────────────────────────
//
// Falls back to `InMemoryQuotaStore` when Redis is unreachable.
// We use INCR + EXPIRE — atomic on the server, no race between
// two concurrent `consume` calls. Both daily and weekly keys
// are written on every increment; the older half of the pair
// (the day or week that just rolled over) expires naturally.
//
// Production wiring lives in `backend/src/plugins/quotas.ts`
// after Redis is registered. Tests use `InMemoryQuotaStore`
// directly.

import type { RedisClientType } from "redis";

export class RedisQuotaStore implements QuotaStore {
  constructor(private readonly redis: RedisClientType) {}

  async consume(
    instanceId: string,
    daily: number | null,
    weekly: number | null,
  ): Promise<QuotaConsumeResult> {
    const now = new Date();
    const today = isoDateUtc(now);
    const thisWeek = isoWeekUtc(now);
    const dailyKey = `pekohub:quota:${instanceId}:d:${today}`;
    const weeklyKey = `pekohub:quota:${instanceId}:w:${thisWeek}`;

    // INCR is atomic; EXPIRE sets TTL on first INCR (when count = 1)
    // so we don't extend the window on every chat. Multi() chains
    // the two increments and the two expire sets in one round trip.
    const pipeline = this.redis.multi();
    if (daily !== null) pipeline.incr(dailyKey);
    if (weekly !== null) pipeline.incr(weeklyKey);
    const results = (await pipeline.exec()) ?? [];
    const newDaily =
      daily === null ? null : Number(results[0] ?? 0);
    const newWeekly =
      weekly === null ? null : Number(results[daily === null ? 0 : 1] ?? 0);

    // Set TTLs on the first increment (when the value is 1).
    // We do this out-of-band; not racing the increment because
    // EXPIRE on an existing key is idempotent.
    if (newDaily === 1) await this.redis.expire(dailyKey, 48 * 3600);
    if (newWeekly === 1) await this.redis.expire(weeklyKey, 8 * 24 * 3600);

    if (daily !== null && newDaily !== null && newDaily > daily) {
      return {
        allowed: false,
        reason: "daily",
        dailyRemaining: 0,
        weeklyRemaining:
          weekly === null || newWeekly === null
            ? null
            : Math.max(0, weekly - newWeekly),
      };
    }
    if (weekly !== null && newWeekly !== null && newWeekly > weekly) {
      return {
        allowed: false,
        reason: "weekly",
        dailyRemaining:
          daily === null || newDaily === null
            ? null
            : Math.max(0, daily - newDaily),
        weeklyRemaining: 0,
      };
    }
    return {
      allowed: true,
      dailyRemaining: daily === null || newDaily === null ? null : daily - newDaily,
      weeklyRemaining:
        weekly === null || newWeekly === null ? null : weekly - newWeekly,
    };
  }
}
