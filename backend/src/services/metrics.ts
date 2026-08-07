/**
 * Tiny in-process counter registry.
 *
 * Issue #16 adds a hub-level counter surface (`hub.a2a.forwarded`,
 * `hub.a2a.rejected_source_allowlist`, `hub.a2a.target_missing`, etc.)
 * mirroring the existing `proxyChat` telemetry. There's no Prometheus /
 * OpenTelemetry / StatsD client in the backend today, so this is a
 * deliberately minimal registry:
 *
 *   - `inc(name)` / `inc(name, n)` bumps the counter.
 *   - `snapshot()` returns a flat `{ name: count }` object for the
 *     `GET /metrics` JSON endpoint.
 *
 * Singleton exported as `metrics` so call-sites don't have to thread the
 * registry through constructors. Process-global state is fine — counters
 * are diagnostic, not authoritative.
 */
export class CounterRegistry {
  private counters = new Map<string, number>();

  inc(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  snapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [name, value] of this.counters) {
      out[name] = value;
    }
    return out;
  }

  /** Test-only: reset all counters. */
  reset(): void {
    this.counters.clear();
  }
}

export const metrics = new CounterRegistry();

/**
 * Canonical counter names (issue #16 §"Telemetry"). Centralized so a typo
 * in one call site doesn't silently spawn a sibling counter.
 */
export const CounterName = {
  HubA2AForwarded: "hub.a2a.forwarded",
  HubA2ARejectedSourceAllowlist: "hub.a2a.rejected_source_allowlist",
  HubA2ATargetMissing: "hub.a2a.target_missing",
  HubA2ATargetOffline: "hub.a2a.target_offline",
  HubA2AForbidden: "hub.a2a.forbidden",
  HubA2ATimeout: "hub.a2a.timeout",
  // peko-channel cross-runtime PR-C. Channel events are push-only
  // (no request/response), so the counter set is smaller than a2a's:
  // we only count successes + the two error shapes (allowlist
  // mismatch + recipient offline). Hub is pure relay — no
  // missing/forbidden paths because the hub has no channel
  // membership state to consult.
  HubChannelEventForwarded: "hub.channel_event.forwarded",
  HubChannelEventRejectedSourceAllowlist:
    "hub.channel_event.rejected_source_allowlist",
  HubChannelEventRecipientOffline: "hub.channel_event.recipient_offline",
  // peko-channel cross-runtime PR-3a-followup: invite forwarding
  // (TunnelChannelInvite). Hub is pure relay — same three-counter
  // shape as the channel-event path (forwarded / rejected source
  // allowlist / recipient offline). No missing/forbidden
  // counters because the hub has no channel membership state to
  // consult.
  HubChannelInviteForwarded: "hub.channel_invite.forwarded",
  HubChannelInviteRejectedSourceAllowlist:
    "hub.channel_invite.rejected_source_allowlist",
  HubChannelInviteRecipientOffline: "hub.channel_invite.recipient_offline",
} as const;
