import { describe, it, expect, beforeEach } from "vitest";
import { CounterRegistry, CounterName, metrics as defaultRegistry } from "../../src/services/metrics.js";

describe("metrics", () => {
  let registry: CounterRegistry;

  beforeEach(() => {
    registry = new CounterRegistry();
  });

  it("inc() starts a counter at 1", () => {
    registry.inc("test.counter");
    expect(registry.snapshot()).toEqual({ "test.counter": 1 });
  });

  it("inc() accumulates across calls", () => {
    registry.inc("test.counter");
    registry.inc("test.counter");
    registry.inc("test.counter", 3);
    expect(registry.snapshot()).toEqual({ "test.counter": 5 });
  });

  it("inc(by) defaults to 1", () => {
    registry.inc("a");
    registry.inc("a");
    registry.inc("a", 1);
    expect(registry.snapshot().a).toBe(3);
  });

  it("snapshot() returns a flat object of all counters", () => {
    registry.inc("a");
    registry.inc("b", 7);
    expect(registry.snapshot()).toEqual({ a: 1, b: 7 });
  });

  it("snapshot() omits untouched counters", () => {
    expect(registry.snapshot()).toEqual({});
  });

  it("reset() clears all counters", () => {
    registry.inc("a");
    registry.inc("b");
    registry.reset();
    expect(registry.snapshot()).toEqual({});
  });

  it("CounterName exposes canonical channel-forwarding names", () => {
    // Snapshot the keys — if a name changes, callers depending on the
    // JSON `/metrics` output break. Lock the public surface here.
    // (The retired a2a counters were removed with the p2p relay —
    // ADR-058 post-review cleanup.)
    expect(CounterName.HubChannelEventForwarded).toBe(
      "hub.channel_event.forwarded",
    );
    expect(CounterName.HubChannelInviteForwarded).toBe(
      "hub.channel_invite.forwarded",
    );
  });

  it("default singleton is shared across imports (process-global state)", () => {
    // Two writes from different module references hit the same
    // counter — this is the contract tunnel-manager.ts relies on.
    defaultRegistry.reset();
    defaultRegistry.inc(CounterName.HubChannelEventForwarded);
    expect(defaultRegistry.snapshot()[CounterName.HubChannelEventForwarded]).toBe(1);
    defaultRegistry.reset();
  });
});
