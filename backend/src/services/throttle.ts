import { createClient, type RedisClientType } from "redis";

/**
 * Throttle service for pull-stats deduplication.
 *
 * Supports two backends:
 * 1. **Redis** (preferred for production): state survives restarts and works
 *    across multiple backend instances. Enabled automatically when REDIS_URL is set.
 * 2. **In-memory LRU** (fallback): bounded-size Map with TTL sweep to prevent
 *    unbounded memory growth.
 *
 * Both backends enforce two independent windows:
 * - Per-digest:  `${ip}:${digest}` — limits stats writes for the same blob.
 * - Per-namespace: `${ip}:ns:${namespace}` — limits stats writes across all
 *   digests in a namespace (defense-in-depth against digest rotation).
 */

const REDIS_URL = process.env.REDIS_URL;
const DIGEST_TTL_MS = Number(process.env.PULL_STATS_THROTTLE_MS ?? 60_000);
const NAMESPACE_TTL_MS = Number(
  process.env.PULL_STATS_NAMESPACE_TTL_MS ?? 60_000,
);
export const NAMESPACE_MAX = Number(process.env.PULL_STATS_NAMESPACE_MAX ?? 60);

/** In-memory LRU cache entry */
interface LruEntry {
  expiresAt: number;
  count: number;
}

class LruThrottle {
  private map = new Map<string, LruEntry>();
  private maxSize: number;
  private sweepTimer: NodeJS.Timeout;

  constructor(maxSize = 100_000) {
    this.maxSize = maxSize;
    // Periodic sweep to evict expired entries
    const sweepInterval = Math.max(DIGEST_TTL_MS, 10_000);
    this.sweepTimer = setInterval(() => this.sweep(), sweepInterval);
  }

  close() {
    clearInterval(this.sweepTimer);
    this.map.clear();
  }

  private sweep() {
    const now = Date.now();
    for (const [key, entry] of this.map) {
      if (entry.expiresAt <= now) {
        this.map.delete(key);
      }
    }
  }

  /** Set-nx style check: returns true if key already exists (throttled). */
  async checkSetNx(key: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    const entry = this.map.get(key);
    if (entry && entry.expiresAt > now) {
      return true; // throttled
    }
    // Evict oldest if at capacity
    if (this.map.size >= this.maxSize) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) {
        this.map.delete(oldest);
      }
    }
    this.map.set(key, { expiresAt: now + ttlMs, count: 1 });
    return false; // not throttled — allowed to proceed
  }

  /** Increment counter and check limit. Returns true if over limit (throttled). */
  async incrementAndCheck(key: string, ttlMs: number, max: number): Promise<boolean> {
    const now = Date.now();
    const entry = this.map.get(key);
    if (entry && entry.expiresAt > now) {
      entry.count++;
      return entry.count > max;
    }
    // Evict oldest if at capacity
    if (this.map.size >= this.maxSize) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) {
        this.map.delete(oldest);
      }
    }
    this.map.set(key, { expiresAt: now + ttlMs, count: 1 });
    return false; // not throttled — allowed to proceed
  }
}

class RedisThrottle {
  private client: RedisClientType;

  constructor(url: string) {
    this.client = createClient({ url });
    this.client.on("error", (err) => {
      // eslint-disable-next-line no-console
      console.error("Redis throttle error:", err);
    });
    this.client.connect().catch(() => {
      // Connection errors are handled by the error listener above
    });
  }

  async close() {
    await this.client.quit().catch(() => {});
  }

  /** Set-nx style check: returns true if key already exists (throttled). */
  async checkSetNx(key: string, ttlMs: number): Promise<boolean> {
    try {
      const result = await this.client.set(key, "1", {
        NX: true,
        PX: ttlMs,
      });
      // If NX succeeded (result === "OK"), the key didn't exist → not throttled
      // If NX failed (result === null), the key already exists → throttled
      return result === null;
    } catch {
      // Redis unavailable — fall through to allow the request (fail open)
      return false;
    }
  }

  /** Increment counter and check limit. Returns true if over limit (throttled). */
  async incrementAndCheck(key: string, ttlMs: number, max: number): Promise<boolean> {
    try {
      const multi = this.client.multi();
      multi.incr(key);
      multi.pExpire(key, ttlMs);
      const results = await multi.exec();
      const count = Number(results?.[0] ?? 0);
      return count > max;
    } catch {
      // Redis unavailable — fall through to allow the request (fail open)
      return false;
    }
  }
}

let globalThrottle: LruThrottle | RedisThrottle | null = null;

function getThrottle(): LruThrottle | RedisThrottle {
  if (!globalThrottle) {
    if (REDIS_URL) {
      globalThrottle = new RedisThrottle(REDIS_URL);
    } else {
      globalThrottle = new LruThrottle();
    }
  }
  return globalThrottle;
}

/**
 * Determine whether pull-stats should be recorded for this request.
 * Returns `true` if the caller should write stats, `false` to skip.
 */
export async function shouldRecordPullStats(
  ip: string,
  digest: string,
  namespace: string,
): Promise<boolean> {
  const throttle = getThrottle();

  // Per-digest throttle
  const digestKey = `pull:digest:${ip}:${digest}`;
  const digestThrottled = await throttle.checkSetNx(digestKey, DIGEST_TTL_MS);
  if (digestThrottled) {
    return false;
  }

  // Per-namespace throttle (fixed-window counter with PEXPIRE refresh)
  const nsKey = `pull:ns:${ip}:${namespace}`;
  const nsThrottled = await throttle.incrementAndCheck(
    nsKey,
    NAMESPACE_TTL_MS,
    NAMESPACE_MAX,
  );
  if (nsThrottled) {
    // Already at namespace limit — skip stats but still serve blob
    return false;
  }

  return true;
}

/** For testing: reset the global throttle instance and clear state */
export function resetThrottleForTests(): void {
  if (globalThrottle instanceof LruThrottle) {
    globalThrottle.close();
  } else if (globalThrottle instanceof RedisThrottle) {
    globalThrottle.close().catch(() => {});
  }
  globalThrottle = null;
}
