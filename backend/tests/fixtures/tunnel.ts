/**
 * Shared tunnel test fixtures.
 *
 * Extracted from `tunnel-proxy.test.ts` so that `agent_forwarding.test.ts`
 * (issue #16) can reuse the same mock WebSocket + handshake helpers
 * without copy-pasting the auth and signing logic.
 *
 * Three pieces:
 *
 *   1. `MockWebSocket` — `EventEmitter` that records `sent` messages and
 *      lets the test trigger inbound messages with `triggerMessage`. The
 *      fields `OPEN`/`readyState`/`send`/`close` mirror the relevant
 *      surface of the `ws` package's `WebSocket` so `TunnelManager` can
 *      treat it as one (with a `as unknown as WebSocket` cast at the
 *      call site).
 *
 *   2. `makeRuntimeIdentity` / `signHello` — Ed25519 keygen + sign with
 *      the did:key multibase encoding used by `tunnel-crypto.ts`.
 *
 *   3. `completeHandshake` — runs the full three-step
 *      `runtime_hello` → `tunnel_challenge` → `tunnel_challenge_ack`
 *      dance against a `MockWebSocket`. Returns once the connection is
 *      in the "ready" state (server has sent `tunnel_ready`).
 */

import { EventEmitter } from "events";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { encodeTunnelMessage, type TunnelMessage } from "../../src/services/tunnel-protocol.js";
import type { WebSocket } from "ws";
import type { TestDb } from "./db.js";

const ED25519_PUB_MULTICODEC = new Uint8Array([0xed, 0x01]);

export class MockWebSocket extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  sent: TunnelMessage[] = [];
  closed = false;
  closeCode?: number;
  closeReason?: string;

  send(data: Buffer) {
    this.sent.push(JSON.parse(data.toString("utf8")) as TunnelMessage);
  }

  close(code?: number, reason?: string) {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = 3;
    this.emit("close");
  }

  triggerMessage(msg: TunnelMessage) {
    this.emit("message", Buffer.from(JSON.stringify(msg), "utf8"));
  }

  /**
   * Synchronous version that emits a buffer of pre-encoded bytes. Useful
   * for forcing the tunnel manager to walk the decode path with arbitrary
   * payloads (malformed-message tests).
   */
  triggerRaw(buffer: Buffer) {
    this.emit("message", buffer);
  }

  /**
   * Like `send` but produces the encoded buffer form (rather than the
   * parsed `TunnelMessage`). Useful when tests want to inspect the exact
   * wire bytes (e.g. confirming a forwarded envelope is verbatim).
   */
  sendRaw(msg: TunnelMessage): Buffer {
    const buf = encodeTunnelMessage(msg);
    this.sent.push(msg);
    return buf;
  }

  asWebSocket(): WebSocket {
    return this as unknown as WebSocket;
  }
}

export function makeRuntimeIdentity(): {
  did: string;
  privateKey: Uint8Array;
} {
  const { secretKey } = ed25519.keygen();
  const publicKey = ed25519.getPublicKey(secretKey);
  const encoded = base58.encode(
    new Uint8Array([...ED25519_PUB_MULTICODEC, ...publicKey]),
  );
  return { did: `did:key:z${encoded}`, privateKey: secretKey };
}

export function signHello(
  privateKey: Uint8Array,
  nonce: string,
): string {
  const signature = ed25519.sign(new TextEncoder().encode(nonce), privateKey);
  return Buffer.from(signature).toString("base64");
}

/**
 * Run the full three-step handshake against a `MockWebSocket`:
 *   1. send `runtime_hello`
 *   2. read the server's `tunnel_challenge`
 *   3. sign + send the `tunnel_challenge_ack`
 * Returns when the connection is in the "ready" state.
 */
export async function completeHandshake(
  socket: MockWebSocket,
  did: string,
  privateKey: Uint8Array,
  helloNonce = "nonce-1",
): Promise<void> {
  socket.triggerMessage({
    type: "runtime_hello",
    runtimeId: did,
    nonce: helloNonce,
    signature: signHello(privateKey, helloNonce),
  });
  for (let i = 0; i < 100 && !socket.sent.some((m) => m.type === "tunnel_challenge"); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  const challenge = socket.sent.find((m) => m.type === "tunnel_challenge");
  if (!challenge || challenge.type !== "tunnel_challenge") {
    throw new Error("Server did not send tunnel_challenge");
  }
  socket.triggerMessage({
    type: "tunnel_challenge_ack",
    nonce: challenge.nonce,
    signature: signHello(privateKey, challenge.nonce),
  });
  for (let i = 0; i < 100 && !socket.sent.some((m) => m.type === "tunnel_ready"); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  if (!socket.sent.some((m) => m.type === "tunnel_ready")) {
    throw new Error("Server did not send tunnel_ready");
  }
}

/**
 * Pre-insert a `runtimes` row so the new handshake allowlist
 * (pekohub issue #1) admits the runtime.
 */
export async function seedRuntime(
  testDb: TestDb,
  did: string,
  ownerId: number,
  displayName = "Test Runtime",
): Promise<void> {
  await testDb.client.query(
    `INSERT INTO runtimes (runtime_did, owner_id, display_name) VALUES ($1, $2, $3)
     ON CONFLICT (runtime_did) DO NOTHING`,
    [did, ownerId, displayName],
  );
}
