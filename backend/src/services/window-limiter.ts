/**
 * A per-key sliding-window limiter kept in memory (per-IP caps on sign-in,
 * OAuth and the public chat proxy). Keys idle for a whole window are swept
 * once a window, and the table never holds more than `maxKeys`, so a stream
 * of new IPs can't grow it without bound.
 */
export class WindowLimiter {
  private hits = new Map<string, number[]>();
  private lastSweep = 0;

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly maxKeys = 50_000,
  ) {}

  /** Count a hit for `key`; false (and not counted) once it has `max` in the window. */
  allow(key: string, now = Date.now()): boolean {
    if (now - this.lastSweep >= this.windowMs) this.sweep(now);
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    const allowed = recent.length < this.max;
    if (allowed) recent.push(now);
    // Re-insert so iteration order is least recently used first.
    this.hits.delete(key);
    this.hits.set(key, recent);
    if (this.hits.size > this.maxKeys) {
      const oldest = this.hits.keys().next().value;
      if (oldest !== undefined) this.hits.delete(oldest);
    }
    return allowed;
  }

  /** Seconds to tell a refused caller to wait. */
  get retryAfterSeconds(): number {
    return Math.ceil(this.windowMs / 1000);
  }

  /** Keys tracked now (tests). */
  get size(): number {
    return this.hits.size;
  }

  private sweep(now: number) {
    for (const [key, times] of this.hits) {
      if (times.length === 0 || now - times[times.length - 1] >= this.windowMs) this.hits.delete(key);
    }
    this.lastSweep = now;
  }
}
