/**
 * Snowflake IDs for groups (peko-runtime ADR-092 D5): 64-bit, time-ordered,
 * written in decimal, like Discord's server IDs.
 *
 *   41 bits  milliseconds since 2026-01-01T00:00:00Z
 *   10 bits  worker (this process: 0; the Hub runs one node)
 *   12 bits  sequence within the millisecond
 */

const EPOCH_MS = BigInt(Date.UTC(2026, 0, 1));
const WORKER = 0n;

let lastMs = -1n;
let sequence = 0n;

/** A new snowflake, as a decimal string. */
export function nextSnowflake(now: number = Date.now()): string {
  let ms = BigInt(now) - EPOCH_MS;
  if (ms < lastMs) ms = lastMs; // a clock step back reuses the last millisecond
  if (ms === lastMs) {
    sequence = (sequence + 1n) & 0xfffn;
    if (sequence === 0n) ms = lastMs + 1n; // 4096 in one millisecond: borrow the next
  } else {
    sequence = 0n;
  }
  lastMs = ms;
  return ((ms << 22n) | (WORKER << 12n) | sequence).toString();
}

/** When a snowflake was minted. */
export function snowflakeTime(id: string): Date {
  return new Date(Number((BigInt(id) >> 22n) + EPOCH_MS));
}

/** Whether `id` reads as a snowflake (decimal digits only). */
export function isSnowflake(id: string): boolean {
  return /^[0-9]{15,20}$/.test(id);
}
