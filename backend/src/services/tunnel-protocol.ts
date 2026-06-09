/**
 * Tunnel Message Protocol
 *
 * TypeScript mirror of the Rust TunnelMessage enum from ADR-035.
 * Messages are serialized as JSON and sent over the WebSocket as binary frames.
 */

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

// --- Instance lifecycle extensions (ADR-004) ---

export type InstanceStatus = "online" | "offline" | "busy" | "error";
export type InstanceExposure = "private" | "public" | "unexposed";
export type InstanceType = "agent" | "team";

export interface InstanceAnnouncePayload {
  id: string;
  type: InstanceType;
  name: string;
  bundleRef?: string;
  runtimeDisplayName?: string;
  status: InstanceStatus;
  exposure: InstanceExposure;
  allowedUsers?: string[];
  capabilities?: string[];
  metadata?: Record<string, unknown>;
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
  allowedUserIds?: string[];
}

export type TunnelMessage =
  | {
      type: "runtime_hello";
      runtimeId: string;
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
  | { type: "exposure_update"; payload: ExposureUpdatePayload };

export function encodeTunnelMessage(msg: TunnelMessage): Buffer {
  return Buffer.from(JSON.stringify(msg), "utf8");
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
  return JSON.parse(buffer.toString("utf8")) as TunnelMessage;
}
