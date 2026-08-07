import { describe, it, expect } from "vitest";
import {
  encodeTunnelMessage,
  decodeTunnelMessage,
} from "../../src/services/tunnel-protocol.js";

describe("tunnel-protocol", () => {
  it("round-trips a runtime_hello message", () => {
    const msg = {
      type: "runtime_hello" as const,
      runtimeId: "did:key:z6MkTest",
      nonce: "abc123",
      signature: "sig456",
    };
    const encoded = encodeTunnelMessage(msg);
    const decoded = decodeTunnelMessage(encoded);
    expect(decoded).toEqual(msg);
  });

  it("round-trips a proxied_request message", () => {
    const msg = {
      type: "proxied_request" as const,
      requestId: "req-123",
      agent: "my-principal",
      payload: [1, 2, 3],
    };
    const encoded = encodeTunnelMessage(msg);
    const decoded = decodeTunnelMessage(encoded);
    expect(decoded).toEqual(msg);
  });

  it("round-trips an exposure_update message", () => {
    const msg = {
      type: "exposure_update" as const,
      payload: {
        instanceId: "inst-1",
        exposure: "public" as const,
        allowedUserIds: ["1", "2"],
      },
    };
    const encoded = encodeTunnelMessage(msg);
    const decoded = decodeTunnelMessage(encoded);
    expect(decoded).toEqual(msg);
  });

  it("handles fragmented Buffer arrays", () => {
    const msg = {
      type: "heartbeat" as const,
      seq: 42,
    };
    const encoded = encodeTunnelMessage(msg);
    const fragments = [encoded.slice(0, 5), encoded.slice(5)];
    const decoded = decodeTunnelMessage(fragments);
    expect(decoded).toEqual(msg);
  });

  /// Round-trip a `tunnel_channel_invite` envelope (peko-channel
  /// cross-runtime PR-3a-followup). Mirrors the runtime's wire
  /// shape: a two-member `initialMembers` snapshot — one local
  /// (`runtimeId` omitted, since the Rust side uses
  /// `skip_serializing_if = "Option::is_none"`) and one remote.
  /// Pins the contract with the runtime's
  /// `TunnelChannelInvitePayload` and the hub's pure-relay
  /// forwarding path.
  it("round-trips a tunnel_channel_invite message", () => {
    const msg = {
      type: "tunnel_channel_invite" as const,
      requestId: "chan-invite-1",
      sourceRuntimeId: "did:key:zRuntimeA",
      recipientRuntimeId: "did:key:zRuntimeB",
      sourcePrincipalDid: "prin_alice",
      channelId: "chan_abcdefgh",
      creator: "prin_alice",
      name: "team-chat",
      // Local member has no `runtimeId` (matches
      // `#[serde(skip_serializing_if = "Option::is_none")]` on the
      // Rust side). Remote member carries the peer runtime id.
      initialMembers: [
        { principalDid: "prin_alice" },
        {
          principalDid: "prin_bob",
          runtimeId: "did:key:zRuntimeB",
        },
      ],
      signature: "base64url-sig",
    };
    const encoded = encodeTunnelMessage(msg);
    const decoded = decodeTunnelMessage(encoded);
    expect(decoded).toEqual(msg);
  });
});
