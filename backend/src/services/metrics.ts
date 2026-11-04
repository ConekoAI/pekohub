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
  HubChannelEventRateLimited: "hub.channel_event.rate_limited",
  HubChannelInviteRateLimited: "hub.channel_invite.rate_limited",
  HubPeerRuntimeOnlineSent: "hub.peer_runtime_online.sent",
  HubHistoryForwarded: "hub.channel_history.forwarded",
  HubHistoryRequestRejectedPerson: "hub.channel_history.rejected_person",
  HubHistoryRequestRateLimited: "hub.channel_history.rate_limited",
  HubGroupInvitationForwarded: "hub.group_invitation.forwarded",
  HubGroupInvitationRateLimited: "hub.group_invitation.rate_limited",
  HubGroupJoinForwarded: "hub.group_join.forwarded",
  HubGroupJoinRejectedPerson: "hub.group_join.rejected_person",
  // Runtime ADR-095 D5: a runtime's request for its person's DMs, delivered
  // to the account's other runtimes, and their answers; refused when the
  // runtimes are not the same account's.
  HubAccountDmsRequestForwarded: "hub.account_dms_request.forwarded",
  HubAccountDmsForwarded: "hub.account_dms.forwarded",
  HubAccountDmsRejectedAccount: "hub.account_dms.rejected_account",
  // Runtime ADR-095 D6: a person's DM invite delivered to another person's
  // runtimes, route announcements between runtimes in a DM between people,
  // and those refused for speaking for someone else's account.
  HubPersonDmInviteForwarded: "hub.person_dm_invite.forwarded",
  HubDmRouteForwarded: "hub.dm_route.forwarded",
  HubPersonDmRejectedPerson: "hub.person_dm.rejected_person",
  // Runtime ADR-090 D3: an envelope speaking for a person
  // (`user:hub:<account>`) from a runtime registered to another account.
  HubChannelEventRejectedPersonAccount: "hub.channel_event.rejected_person_account",
  HubChannelInviteRejectedPersonAccount: "hub.channel_invite.rejected_person_account",
  // Runtime ADR-094: attachment chunks relayed between runtimes, and those
  // dropped for size or rate.
  HubAttachmentForwarded: "hub.attachment.forwarded",
  HubAttachmentChunkRejected: "hub.attachment.chunk_rejected",
  HubAttachmentRateLimited: "hub.attachment.rate_limited",
} as const;
