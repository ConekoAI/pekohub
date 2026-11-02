import { describe, it, expect } from "vitest";
import { isSnowflake, nextSnowflake, snowflakeTime } from "../snowflake.js";

describe("snowflake group IDs", () => {
  it("are decimal, increase, and carry their time", () => {
    const at = Date.UTC(2026, 10, 3, 12, 0, 0);
    const ids = Array.from({ length: 5000 }, () => nextSnowflake(at));
    expect(new Set(ids).size).toBe(ids.length);
    for (let i = 1; i < ids.length; i++) expect(BigInt(ids[i]) > BigInt(ids[i - 1])).toBe(true);
    expect(ids.every(isSnowflake)).toBe(true);
    expect(Math.abs(snowflakeTime(ids[0]).getTime() - at)).toBeLessThan(5);
  });

  it("tells a group ID from other references", () => {
    expect(isSnowflake("@alice")).toBe(false);
    expect(isSnowflake("alice/ada")).toBe(false);
    expect(isSnowflake("12")).toBe(false);
  });
});
