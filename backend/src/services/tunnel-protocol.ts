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
  agent: string;
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

// --- Instance lifecycle extensions (ADR-004, ADR-041) ---

export type InstanceStatus = "online" | "offline" | "busy" | "error";
export type InstanceExposure = "private" | "public" | "unexposed";
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
  // ADR-041: typed allow-list. Each entry is a `Subject`.
  allowedPrincipals?: Subject[];
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
  /** ADR-041: typed allow-list (Subject[]). */
  allowedPrincipals?: Subject[];
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
  sessionId?: string;
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
      agent: string;
      payload: number[];
    }
  | { type: "proxied_response"; requestId: string; payload: number[] }
  | { type: "stream_chunk"; requestId: string; seq: number; payload: number[] }
  | { type: "stream_end"; requestId: string }
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
      sessionId?: string;
      message: string;
      signature: string;
    }
  | {
      type: "principal_to_principal_response";
      requestId: string;
      payload: string;
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
