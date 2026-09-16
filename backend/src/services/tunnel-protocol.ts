/**
 * Tunnel Message Protocol
 *
 * TypeScript mirror of the Rust TunnelMessage enum from ADR-035.
 * Messages are serialized as JSON and sent over the WebSocket as binary frames.
 */

import type { Subject } from "@pekohub/shared";

export interface RuntimeHelloPayload {
  runtimeId: string; // did:key format
  nonce: string;
  signature: string; // base64-encoded Ed25519 signature of nonce
}

export interface TunnelReadyPayload {
  heartbeatIntervalSecs: number;
}

export interface HeartbeatPayload {
  seq: number;
}

export interface DisconnectPayload {
  reason: string;
}

/** Wire-format proxied request sent inside the tunnel (matches Rust). */
export interface TunnelProxiedRequest {
  requestId: string;
  principal: string;
  payload: number[]; // serialized IPC RequestPacket as bytes
}

/** Internal HTTP-bridge payload used by InstanceService / TunnelRouter. */
export interface HttpProxiedRequest {
  requestId: string;
  instanceId: string;
  principalName: string;
  method: "chat" | "stream";
  body: unknown;
  headers: Record<string, string>;
}

export interface ProxiedResponsePayload {
  requestId: string;
  payload: number[]; // serialized IPC ResponsePacket as bytes
}

export interface StreamChunkPayload {
  requestId: string;
  seq: number;
  payload: number[];
}

export interface StreamEndPayload {
  requestId: string;
}

/**
 * PR-B2: per-iteration boundary marker on the streaming channel
 * (peko-runtime#rfc `TunnelMessage::StreamIteration`). The runtime
 * emits these just before the first token chunk of each
 * agentic loop iteration so the hub can re-project them as SSE
 * `event: iteration` lines for the SPA's iteration-bubble UI.
 *
 * Iteration is 1-based and per `requestId`. The hub-side
 * decoder (in `tunnel-manager.ts` `handleStreamIteration`) is
 * intentionally minimal — opaque payload, no schema migration —
 * because the runtime pins the wire shape in
 * `peko-runtime/peko-rs/core/src/tunnel/protocol.rs`.
 */
export interface StreamIterationPayload {
  requestId: string;
  iteration: number;
}

// --- Instance lifecycle extensions (ADR-004, ADR-041) ---

export type InstanceStatus = "online" | "offline" | "busy" | "error";
export type InstanceExposure = "private" | "public" | "unexposed" | "unlisted";
export type InstanceType = "principal";

export interface InstanceAnnouncePayload {
  id: string;
  type: InstanceType;
  name: string;
  bundleRef?: string;
  runtimeDisplayName?: string;
  status: InstanceStatus;
  exposure: InstanceExposure;
  // ADR-041: typed owner per ADR-041 (Subject enum, was Principal in
  // ADR-039). When present, the hub stores it as `owner_subject` and
  // the access checks use it. When absent, the hub falls back to the
  // legacy numeric `ownerId` (the user that owns the runtime, via
  // the `runtimes` table).
  owner?: Subject;
  // Post-H4: allowedPrincipals removed from the announce payload.
  // The runtime owns the ACL surface in `PrincipalConfig.permissions`
  // (R4); pekohub only stores the public-vs-private exposure switch.
  capabilities?: string[];
  metadata?: Record<string, unknown>;
  // ADR-041: per-Principal DID, written to `instances.principal_did`
  // and indexed by the by-did resolver
  // (`GET /v1/principals/by-did/:did`). Optional so pre-#82
  // runtimes still announce cleanly. Omit to leave the existing
  // value alone in the service layer.
  principalDid?: string;
}

export interface InstanceHeartbeatPayload {
  id: string;
  status: InstanceStatus;
  timestamp: string;
}

export interface InstanceDeregisterPayload {
  id: string;
}

export interface ExposureUpdatePayload {
  instanceId: string;
  exposure: InstanceExposure;
  // Post-H4: allowedPrincipals removed. The runtime owns the ACL
  // surface (R4); pekohub only announces the public-vs-private switch.
}

export interface StatusUpdatePayload {
  instanceId: string;
  status: InstanceStatus;
}

// ── Cross-runtime a2a (issue #16, ADR-041 P2P) ───────────────────────────────
//
// The hub forwards these envelopes *opaquely* between runtime tunnels.
// It reads only the routing fields (`callerRuntimeId`, `targetPrincipalDid`,
// `requestId`); the `signature` and `message` are relayed verbatim so the
// target runtime can verify end-to-end. Synthesized error responses use
// the same `principal_to_principal_response` envelope with a JSON-encoded
// payload shaped `{ kind: "error", code, message }`.

export interface PrincipalToPrincipalRequestPayload {
  requestId: string;
  callerRuntimeId: string;
  callerPrincipalDid: string;
  targetPrincipalDid: string;
  message: string;
  signature: string;
}

export interface PrincipalToPrincipalResponsePayload {
  requestId: string;
  /**
   * Opaque to the hub — relayed verbatim. Successful responses carry
   * the runtime's `principal_send` result string; failures
   * (synthesized by the hub on missing target, ACL deny, etc.)
   * carry a JSON-encoded `{ kind: "error", code, message }` object.
   */
  payload: string;
}

// ── Cross-runtime channel events (peko-channel cross-runtime PR-C) ──────────
//
// Mirror of Rust `TunnelMessage::TunnelChannelEvent`
// (`peko-runtime/peko-rs/core/src/tunnel/protocol.rs:405`). The hub is
// pure relay: it reads only `sourceRuntimeId` (for the source allowlist
// + recipient lookup) and forwards the envelope verbatim to every
// connected recipient runtime. Channel events are push-only — there
// is no request/response round-trip — so the hub does NOT carry a
// `tunnel_channel_event_ack` variant. The runtime emits one
// `TunnelChannelEvent` per recipient runtime (deduped on the source
// side by `runtime_id`), so the hub handles each as a single forward.
//
// `event` mirrors Rust `peko_protocol::channel::ChannelEvent`'s
// `#[serde(tag = "kind", rename_all = "snake_case")]` shape: a
// discriminated union over `{ created, posted, member_joined,
// member_left }`. The hub does NOT inspect the discriminant — it
// forwards verbatim so the receiver can write the event into its
// local mirror without round-tripping the source.

export interface ChannelEvent {
  kind: "created" | "posted" | "member_joined" | "member_left";
  channel: string;
  // `created`
  creator?: string;
  name?: string;
  // `posted`
  author?: string;
  parent?: string | null;
  text?: string;
  // `member_joined` / `member_left`
  member?: string;
  // RFC3339 timestamp assigned by the source runtime. Receiver MUST
  // NOT re-stamp on append.
  at: string;
}

export interface TunnelChannelEventPayload {
  /** Unique-per-fanout id (UUIDv4 from the source runtime). Not used
   * for response correlation — exists so the hub can scope replay
   * protection and audit logs can join outbound/inbound rows. */
  requestId: string;
  /** The source runtime's `did:key` form. The hub enforces
   * `conn.runtimeId === msg.sourceRuntimeId` (source allowlist). The
   * receiver derives the verifying key from this DID. */
  sourceRuntimeId: string;
  /** The runtime the hub should forward this envelope to. The
   * outbound `fanout_event` loop emits one envelope per unique
   * recipient runtime, with each envelope addressed to that
   * runtime's `did:key`. Without this field the hub has no way to
   * route — see peko-channel cross-runtime PR-B commit 4. */
  recipientRuntimeId: string;
  /** The local principal on the source runtime that authored the
   * event. Carried for audit only — signature is over the runtime
   * pre-image, not the principal. */
  sourcePrincipalDid: string;
  /** The channel id (`chan_<8 base36>`). The receiver looks up the
   * local mirror directory and appends `event` to `events.jsonl`
   * under it. */
  channelId: string;
  /** The full `ChannelEvent` payload. Forwarded verbatim. */
  event: ChannelEvent;
  /** ADR-058 D3: compact JWS (EdDSA, embedded payload) by the source
   * runtime's key. The payload carries every envelope field plus
   * `iat`/`exp`. The hub forwards this verbatim; the receiver
   * verifies end-to-end. */
  signature: string;
  /** ADR-058 D2: compact JWS by the authoring principal's own key
   * over the SAME payload segment as `signature`. Empty when the
   * author has no vault-backed key (legacy runtime-vouched path).
   * The hub forwards this verbatim; the receiver verifies it against
   * the key embedded in `sourcePrincipalDid` when that is a
   * `did:key`. */
  authorSignature: string;
}

// ── Cross-runtime channel invites (peko-channel cross-runtime PR-3a-followup) ─
//
// Mirror of Rust `TunnelMessage::TunnelChannelInvite`
// (`peko-runtime/peko-rs/core/src/tunnel/protocol.rs`). The hub is
// pure relay, identical shape to the channel-event path: read
// `sourceRuntimeId` (source allowlist) + `recipientRuntimeId`
// (routing), forward verbatim. The `initialMembers` snapshot is
// what the receiver uses to bootstrap its local mirror without a
// follow-up `peek` round-trip.

/** One row of the `initialMembers` list on `TunnelChannelInvite`.
 * Mirrors Rust `peko_protocol::channel::InitialMember`:
 * `runtime_id: None` means the principal is local to the source
 * runtime (will land in `members.json`'s local array); `Some(id)`
 * means the principal lives on a peer runtime and the receiver
 * should record a `RemoteMember` row in `members.json`. */
export interface InitialMember {
  principalDid: string;
  /** `undefined` (not present on JSON) when the principal is local to
   * the source runtime. The Rust side uses
   * `#[serde(skip_serializing_if = "Option::is_none")]`, so on the
   * wire `runtimeId` is *omitted* (not `null`) for local members —
   * we mirror that by typing the field as `string | undefined`. */
  runtimeId?: string;
}

export interface TunnelChannelInvitePayload {
  /** Unique-per-fanout id (UUIDv4 from the source runtime). Used by
   * the audit trail to join outbound/inbound rows. Not used for
   * response correlation — invites are push-only. */
  requestId: string;
  /** The source runtime's `did:key` form. The hub enforces
   * `conn.runtimeId === msg.sourceRuntimeId` (source allowlist). The
   * receiver derives the verifying key from this DID and rejects
   * the envelope if `signature` does not verify. */
  sourceRuntimeId: string;
  /** The runtime the hub should forward this envelope to. The
   * outbound `fanout_invite` loop emits one envelope per unique
   * invitee runtime. Without this field the hub has no way to
   * route — channel membership tracking is a source-runtime concern. */
  recipientRuntimeId: string;
  /** The local principal on the source runtime that issued the
   * invite. Recorded for audit only — the signature is over the
   * runtime-level pre-image. */
  sourcePrincipalDid: string;
  /** The channel id (`chan_<8 base36>`). The receiver looks up the
   * local mirror directory and calls `join_remote` with the rest of
   * the envelope to bootstrap it. */
  channelId: string;
  /** The creator's display name (principal DID, e.g. `prin_alice`).
   * Snapshotted from the source runtime's `meta.json` at invite
   * time so the receiver doesn't need a follow-up `peek` to display
   * the channel. */
  creator: string;
  /** Human-readable channel name (`team`, `general`, etc.).
   * Snapshotted from the source runtime's `meta.json` at invite
   * time. */
  name: string;
  /** Initial membership snapshot: every principal that should
   * appear in the receiver's `members.json` row table. The
   * receiver partitions on `runtime_id` to build both the
   * `members` and `remote_members` arrays. */
  initialMembers: InitialMember[];
  /** ADR-058 D3: compact JWS (EdDSA, embedded payload) by the source
   * runtime's key. The payload carries every envelope field plus
   * `iat`/`exp`. The hub forwards this verbatim; the receiver
   * verifies end-to-end. */
  signature: string;
  /** ADR-058 D2: compact JWS by the creator principal's own key over
   * the SAME payload segment as `signature`. Empty for legacy
   * runtime-vouched invites; required (plus
   * `creatorDid === sourcePrincipalDid`) when `creatorDid` is a
   * `did:key`. The hub forwards this verbatim. */
  authorSignature: string;
}

export type TunnelMessage =
  | {
      type: "runtime_hello";
      runtimeId: string;
      nonce: string;
      signature: string;
    }
  | {
      /** Server-issued challenge after `runtime_hello` is accepted. */
      type: "tunnel_challenge";
      /** Base64url-encoded 32-byte random nonce. */
      nonce: string;
    }
  | {
      /** Runtime's signed response to a `tunnel_challenge`. */
      type: "tunnel_challenge_ack";
      nonce: string;
      signature: string;
    }
  | { type: "tunnel_ready"; heartbeatIntervalSecs: number }
  | { type: "heartbeat"; seq: number }
  | { type: "heartbeat_ack"; seq: number }
  | { type: "disconnect"; reason: string }
  | {
      type: "proxied_request";
      requestId: string;
      principal: string;
      payload: number[];
    }
  | { type: "proxied_response"; requestId: string; payload: number[] }
  | { type: "stream_chunk"; requestId: string; seq: number; payload: number[] }
  | { type: "stream_end"; requestId: string }
  | { type: "stream_iteration"; requestId: string; iteration: number }
  | { type: "instance_announce"; payload: InstanceAnnouncePayload }
  | { type: "instance_heartbeat"; payload: InstanceHeartbeatPayload }
  | { type: "instance_deregister"; payload: InstanceDeregisterPayload }
  | { type: "exposure_update"; payload: ExposureUpdatePayload }
  | { type: "status_update"; payload: StatusUpdatePayload }
  // Cross-runtime P2P forwarding — see backend issue #16 + ADR-041.
  | {
      type: "principal_to_principal_request";
      requestId: string;
      callerRuntimeId: string;
      callerPrincipalDid: string;
      targetPrincipalDid: string;
      message: string;
      signature: string;
    }
  | {
      type: "principal_to_principal_response";
      requestId: string;
      payload: string;
    }
  // PR #11: invite-token mint / revoke. The hub does not understand
  // the token shape — it just forwards the request to the runtime
  // and surfaces the response. The runtime's InviteRevocationSet
  // (in-memory) is the source of truth for "is this jti burned?".
  | {
      type: "invite_mint";
      requestId: string;
      principal: string;
      scope: string[];
      ttlSecs: number;
    }
  | {
      type: "invite_minted";
      requestId: string;
      token: string;
      url: string;
      claims: {
        principalDid: string;
        principalName: string;
        ownerSubject: string;
        scope: string[];
        exp: number;
        jti: string;
      };
    }
  | {
      type: "invite_revoke";
      requestId: string;
      principal: string;
      jti: string;
    }
  | { type: "invite_revoked"; requestId: string; jti: string }
  // peko-channel cross-runtime PR-C: cross-runtime channel events.
  // The hub is pure relay — it reads `sourceRuntimeId` to enforce
  // the source allowlist and `recipientRuntimeId` to route to the
  // correct recipient tunnel connection. The `event`, `signature`,
  // and `sourcePrincipalDid` fields are forwarded verbatim.
  | {
      type: "tunnel_channel_event";
      requestId: string;
      sourceRuntimeId: string;
      recipientRuntimeId: string;
      sourcePrincipalDid: string;
      channelId: string;
      event: ChannelEvent;
      signature: string;
    }
  // peko-channel cross-runtime PR-3a-followup: cross-runtime
  // channel invites. Hub is pure relay (same shape as the
  // channel-event path): source allowlist + recipient lookup +
  // forward verbatim. Invites are push-only (no request/response),
  // so the hub does NOT carry a `tunnel_channel_invite_ack`
  // variant. The runtime emits one `TunnelChannelInvite` per
  // unique invitee runtime (deduped on the source side by
  // `runtime_id`).
  | {
      type: "tunnel_channel_invite";
      requestId: string;
      sourceRuntimeId: string;
      recipientRuntimeId: string;
      sourcePrincipalDid: string;
      channelId: string;
      creator: string;
      name: string;
      initialMembers: InitialMember[];
      signature: string;
    };

export function encodeTunnelMessage(msg: TunnelMessage): Buffer {
  return Buffer.from(JSON.stringify(msg), "utf-8");
}

export function decodeTunnelMessage(
  data: Buffer | ArrayBuffer | Buffer[],
): TunnelMessage {
  let buffer: Buffer;
  if (Array.isArray(data)) {
    buffer = Buffer.concat(data);
  } else if (Buffer.isBuffer(data)) {
    buffer = data;
  } else {
    buffer = Buffer.from(data);
  }
  return JSON.parse(buffer.toString("utf-8")) as TunnelMessage;
}
