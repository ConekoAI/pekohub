import { describe, it, expect } from "vitest";
import { WindowLimiter } from "../../src/services/window-limiter.js";

describe("WindowLimiter", () => {
  it("allows max a window per key, then again once the window passes", () => {
    const limiter = new WindowLimiter(2, 1_000);
    expect(limiter.allow("a", 0)).toBe(true);
    expect(limiter.allow("a", 10)).toBe(true);
    expect(limiter.allow("a", 20)).toBe(false);
    expect(limiter.allow("b", 20)).toBe(true);
    expect(limiter.allow("a", 1_005)).toBe(true);
  });

  it("forgets idle keys and never tracks more than maxKeys", () => {
    const limiter = new WindowLimiter(5, 1_000, 100);
    for (let n = 0; n < 1_000; n++) limiter.allow(`ip-${n}`, n);
    expect(limiter.size).toBeLessThanOrEqual(100);
    limiter.allow("late", 5_000);
    expect(limiter.size).toBe(1);
  });
});
