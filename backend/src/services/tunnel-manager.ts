/**
 * TunnelManager — Central coordinator for runtime WebSocket tunnels.
 *
 * Owns all runtime connections, handles authentication, heartbeats,
 * request routing, and control messages.
 */

import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import {
  decodeTunnelMessage,
  encodeTunnelMessage,
  type TunnelMessage,
  type HttpProxiedRequest,
  type InstanceAnnouncePayload,
  type InstanceHeartbeatPayload,
  type InstanceDeregisterPayload,
  type StatusUpdatePayload,
} from "./tunnel-protocol.js";
import { verifyDidKeySignature, verifyDidKeyJws, TunnelAuthError } from "./tunnel-crypto.js";
import { instanceService, type InstanceStatus } from "./instances.js";
import { auditService } from "./audit.js";
import { metrics, CounterName } from "./metrics.js";
import { db } from "../db/index.js";
import { runtimes, instances, hubPrincipals } from "../db/schema.js";
import { eq, inArray, and } from "drizzle-orm";

const HELLO_TIMEOUT_MS = 10_000;
const CHALLENGE_TIMEOUT_MS = 10_000;
const HEARTBEAT_INTERVAL_SECS = 30;
const HEARTBEAT_TIMEOUT_MS = 90_000;
/** A connection heard from within this window is live and cannot be displaced. */
const LIVE_CONNECTION_WINDOW_MS = 2 * HEARTBEAT_INTERVAL_SECS * 1000;
const REAPER_INTERVAL_MS = 30_000;
const CHALLENGE_NONCE_BYTES = 32;
/** ADR-058 D4: freshness leeways for the announce `principalPop`
 *  JWS — `exp` may lag the hub clock by 30s, `iat` may lead it by
 *  60s (the runtime mints the PoP immediately before announcing). */
const PRINCIPAL_POP_EXP_LEEWAY_SECS = 30;
const PRINCIPAL_POP_IAT_LEEWAY_SECS = 60;

/** Phases of the runtime-side handshake. */
type HandshakePhase = "hello" | "challenge" | "ready";

/**
 * The text of a runtime's refusal: a string body as is, `{ error }` /
 * `{ message }` objects by that field, else the status.
 */
export function refusalMessage(status: number, body: unknown): string {
  if (typeof body === "string" && body.trim()) return body;
  if (body && typeof body === "object") {
    const fields = body as { error?: unknown; message?: unknown };
    if (typeof fields.error === "string" && fields.error.trim()) return fields.error;
    if (typeof fields.message === "string" && fields.message.trim()) return fields.message;
  }
  return `Request refused (status ${status})`;
}

export interface PendingRequest {
  resolve: (value: { status: number; body: unknown }) => void;
  reject: (reason: Error) => void;
  streamSink?: StreamSink;
  receivedStreamInit: boolean;
  chunks: string[];
  timer?: NodeJS.Timeout;
  /**
   * Re-arms the idle timeout for a streaming request. Called on every
   * inbound stream chunk so that a long but actively-streaming response
   * is not killed by the timeout — only genuine inactivity (no chunk for
   * `timeoutMs`) aborts the stream.
   */
  resetIdleTimer?: () => void;
}

export interface StreamSink {
  onChunk: (chunk: string) => void;
  /**
   * PR-B2: optional per-iteration boundary hook. Older routes
   * (proxyChat's non-event-channel path, any custom consumer)
   * can omit this and the manager will drop iteration frames
   * silently; routes that forward SSE (proxyStream and the
   * public proxyChat) provide it so the SPA can break
   * assistant text into one bubble per agentic iteration.
   */
  onIteration?: (iteration: number) => void;
  onEnd: () => void;
  onError: (err: Error) => void;
}

export interface RuntimeConnection {
  runtimeId: string;
  socket: WebSocket;
  connectedAt: Date;
  lastHeartbeatAt: Date;
  heartbeatTimeout: NodeJS.Timeout | null;
  pendingRequestIds: Set<string>;
}

export class TunnelManager {
  private connections = new Map<string, RuntimeConnection>();
  private pendingRequests = new Map<string, PendingRequest>();
  private reaperTimer: NodeJS.Timeout | null = null;
  /**
   * Per-runtime last-issued challenge nonce. Used to reject a replayed
   * `tunnel_challenge_ack` (the same signed nonce cannot be used to
   * re-handshake). Bounded by LRU eviction — see `MAX_TRACKED_CHALLENGES`.
   */
  private lastChallengeByRuntime = new Map<string, string>();
  private static readonly MAX_TRACKED_CHALLENGES = 4_096;

  constructor(private fastify: FastifyInstance) {}

  startReaper(): void {
    if (this.reaperTimer) return;
    this.reaperTimer = setInterval(() => {
      this.reapStaleConnections();
    }, REAPER_INTERVAL_MS);
    this.reaperTimer.unref?.();
  }

  stopReaper(): void {
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }
  }

  async handleSocket(socket: WebSocket): Promise<void> {
    // Handshake-wide deadline. Re-aimed on every phase transition so
    // a slow-but-honest runtime that takes 25s to sign a 32-byte nonce
    // is still safe: HELLO_TIMEOUT_MS + CHALLENGE_TIMEOUT_MS = 20s.
    let handshakeTimer: NodeJS.Timeout | null = setTimeout(
      () => {
        if (socket.readyState === socket.OPEN) {
          this.sendMessage(socket, {
            type: "disconnect",
            reason: "Handshake timeout",
          });
          socket.close(1008, "Handshake timeout");
        }
      },
      HELLO_TIMEOUT_MS,
    );
    handshakeTimer.unref?.();

    const armTimer = (ms: number) => {
      if (handshakeTimer) clearTimeout(handshakeTimer);
      handshakeTimer = setTimeout(() => {
        if (socket.readyState === socket.OPEN) {
          this.sendMessage(socket, {
            type: "disconnect",
            reason: "Handshake timeout",
          });
          socket.close(1008, "Handshake timeout");
        }
      }, ms);
      handshakeTimer.unref?.();
    };

    let phase: HandshakePhase = "hello";
    let pendingRuntimeId: string | null = null;

    socket.once("close", () => {
      if (handshakeTimer) clearTimeout(handshakeTimer);
    });

    const onMessage = async (data: Buffer | ArrayBuffer | Buffer[]) => {
      let msg: TunnelMessage;
      try {
        msg = decodeTunnelMessage(data);
      } catch (err) {
        this.fastify.log.warn({ err }, "Failed to decode tunnel message");
        this.sendMessage(socket, {
          type: "disconnect",
          reason: "Invalid message encoding",
        });
        socket.close(1003, "Invalid message encoding");
        return;
      }

      try {
        if (phase === "hello") {
          if (msg.type !== "runtime_hello") {
            this.sendMessage(socket, {
              type: "disconnect",
              reason: "Expected RuntimeHello",
            });
            socket.close(1008, "Expected RuntimeHello");
            return;
          }
          pendingRuntimeId = await this.beginHandshake(socket, msg);
          phase = "challenge";
          armTimer(CHALLENGE_TIMEOUT_MS);
          return;
        }

        if (phase === "challenge") {
          if (
            msg.type !== "tunnel_challenge_ack" ||
            pendingRuntimeId === null
          ) {
            this.sendMessage(socket, {
              type: "disconnect",
              reason: "Expected TunnelChallengeAck",
            });
            socket.close(1008, "Expected TunnelChallengeAck");
            return;
          }
          const conn = await this.completeHandshake(
            socket,
            pendingRuntimeId,
            msg,
          );
          phase = "ready";
          if (handshakeTimer) {
            clearTimeout(handshakeTimer);
            handshakeTimer = null;
          }
          // Detach the state-machine listener BEFORE installing the
          // ready-phase listener. Otherwise both fire for every
          // post-handshake message and the state machine immediately
          // closes the socket as "Unexpected message after ready".
          socket.off("message", onMessage);
          this.wireReadyHandlers(conn);
          return;
        }
      } catch (err) {
        this.fastify.log.warn(
          { err, runtimeId: pendingRuntimeId },
          "Tunnel handshake failed",
        );
        const reason =
          err instanceof TunnelAuthError
            ? err.message
            : "Authentication failed";
        this.sendMessage(socket, {
          type: "disconnect",
          reason,
        });
        socket.close(1008, reason);
      }
    };

    socket.on("message", onMessage);
  }

  /**
   * Phase 1: validate the `runtime_hello` (signature + allowlist) and
   * issue a server-side challenge nonce. The connection is not yet
   * registered — that happens in `completeHandshake` once the runtime
   * proves control of the DID by signing our nonce.
   */
  private async beginHandshake(
    socket: WebSocket,
    hello: Extract<TunnelMessage, { type: "runtime_hello" }>,
  ): Promise<string> {
    const { runtimeId, nonce, signature } = hello;

    // 1. Cryptographic check: signature matches the key embedded in the DID.
    if (!verifyDidKeySignature(runtimeId, nonce, signature)) {
      throw new TunnelAuthError("Invalid RuntimeHello signature");
    }

    // 2. Allowlist check: the DID must already be registered in the
    // `runtimes` table. Closing here with 1008 is the P0 fix from
    // pekohub issue #1 — an unregistered DID must not stay connected.
    if (!(await this.isRuntimeAllowed(runtimeId))) {
      throw new TunnelAuthError("unknown runtime");
    }

    // 3. Issue a fresh, server-generated nonce and remember it for
    // replay protection. base64url keeps the wire format stable across
    // the WebSocket text/binary boundary.
    const challengeNonce = randomBytes(CHALLENGE_NONCE_BYTES).toString(
      "base64url",
    );
    this.rememberChallenge(runtimeId, challengeNonce);

    this.sendMessage(socket, { type: "tunnel_challenge", nonce: challengeNonce });
    this.fastify.log.debug(
      { runtimeId },
      "Issued tunnel challenge, awaiting ack",
    );
    return runtimeId;
  }

  /**
   * Phase 2: verify the runtime's signed acknowledgement of our
   * challenge nonce, then promote the socket to a full
   * `RuntimeConnection` and send `tunnel_ready`.
   */
  private async completeHandshake(
    socket: WebSocket,
    runtimeId: string,
    ack: Extract<TunnelMessage, { type: "tunnel_challenge_ack" }>,
  ): Promise<RuntimeConnection> {
    const { nonce, signature } = ack;

    const expected = this.lastChallengeByRuntime.get(runtimeId);
    if (!expected) {
      // No outstanding challenge for this runtime — either it was
      // evicted from the LRU or this is a replay.
      throw new TunnelAuthError("no pending challenge");
    }
    if (expected !== nonce) {
      throw new TunnelAuthError("challenge nonce mismatch");
    }
    if (!verifyDidKeySignature(runtimeId, nonce, signature)) {
      throw new TunnelAuthError("Invalid TunnelChallengeAck signature");
    }

    // Consume the challenge — a single ack must not be replayable.
    this.lastChallengeByRuntime.delete(runtimeId);

    // ADR-081 §5.2: one live tunnel per runtime. Only a runtime that has
    // just proven its key is considered, and it never displaces a live
    // connection (a copied runtime directory must not knock the original
    // offline). A connection that has missed its heartbeats is stale and
    // is replaced, so a restarted runtime reconnects within the window.
    const existing = this.connections.get(runtimeId);
    if (existing) {
      if (Date.now() - existing.lastHeartbeatAt.getTime() <= LIVE_CONNECTION_WINDOW_MS) {
        throw new TunnelAuthError("runtime already connected");
      }
      this.fastify.log.info({ runtimeId }, "Replacing stale tunnel connection");
      this.closeConnection(existing, "stale connection replaced");
    }

    // Touch the runtime's `lastSeenAt` so the allowlist reflects
    // liveness without a separate announcement path. Extracted into
    // a protected method so unit tests without a DB connection can
    // stub it (matches the `isRuntimeAllowed` pattern).
    await this.recordRuntimeConnected(runtimeId);

    const conn: RuntimeConnection = {
      runtimeId,
      socket,
      connectedAt: new Date(),
      lastHeartbeatAt: new Date(),
      heartbeatTimeout: null,
      pendingRequestIds: new Set(),
    };
    this.connections.set(runtimeId, conn);
    this.resetHeartbeatTimeout(conn);

    this.sendMessage(socket, {
      type: "tunnel_ready",
      heartbeatIntervalSecs: HEARTBEAT_INTERVAL_SECS,
    });
    this.fastify.log.info({ runtimeId }, "Runtime tunnel authenticated");
    return conn;
  }

  /**
   * After the handshake is complete, install the long-lived
   * `message`/`close`/`error` listeners.
   */
  private wireReadyHandlers(conn: RuntimeConnection): void {
    const { runtimeId, socket } = conn;
    const messageHandler = (data: Buffer | ArrayBuffer | Buffer[]) => {
      this.handleMessage(conn, data).catch((err) => {
        this.fastify.log.warn(
          { err, runtimeId },
          "Error handling tunnel message",
        );
      });
    };
    socket.on("message", messageHandler);

    socket.once("close", () => {
      this.handleDisconnect(conn);
    });

    socket.once("error", (err) => {
      this.fastify.log.warn({ err, runtimeId }, "Tunnel socket error");
      this.handleDisconnect(conn);
    });
  }

  /** LRU-bounded insert into the challenge map. */
  private rememberChallenge(runtimeId: string, nonce: string): void {
    if (this.lastChallengeByRuntime.size >= TunnelManager.MAX_TRACKED_CHALLENGES) {
      // Evict the oldest entry. `Map` iteration order is insertion
      // order in V8, so the first key is the oldest.
      const oldest = this.lastChallengeByRuntime.keys().next().value;
      if (oldest !== undefined) this.lastChallengeByRuntime.delete(oldest);
    }
    this.lastChallengeByRuntime.set(runtimeId, nonce);
  }

  /**
   * Allowlist check, separated from `beginHandshake` so unit tests
   * that don't wire up a real DB can stub it. Returns `true` iff a
   * row exists in `runtimes` for the given DID.
   */
  protected async isRuntimeAllowed(runtimeId: string): Promise<boolean> {
    const row = await db.query.runtimes.findFirst({
      where: eq(runtimes.runtimeDid, runtimeId),
    });
    return row !== undefined;
  }

  /**
   * Side-effect of a successful handshake: bump the runtime's
   * `lastSeenAt`. Pulled out of `completeHandshake` so the same
   * test isolation story as `isRuntimeAllowed` applies.
   */
  protected async recordRuntimeConnected(_runtimeId: string): Promise<void> {
    await db
      .update(runtimes)
      .set({ lastSeenAt: new Date() })
      .where(eq(runtimes.runtimeDid, _runtimeId));
  }

  private async handleMessage(
    conn: RuntimeConnection,
    data: Buffer | ArrayBuffer | Buffer[],
  ): Promise<void> {
    let msg: TunnelMessage;
    try {
      msg = decodeTunnelMessage(data);
    } catch (err) {
      this.fastify.log.warn(
        { err, runtimeId: conn.runtimeId },
        "Failed to decode tunnel message",
      );
      return;
    }

    switch (msg.type) {
      case "heartbeat": {
        conn.lastHeartbeatAt = new Date();
        this.resetHeartbeatTimeout(conn);
        this.sendMessage(conn.socket, { type: "heartbeat_ack", seq: msg.seq });
        break;
      }

      case "heartbeat_ack": {
        // Runtime-side concern; server just acknowledges
        break;
      }

      case "proxied_response": {
        this.handleProxiedResponse(msg.requestId, msg.payload);
        break;
      }

      case "stream_chunk": {
        this.handleStreamChunk(msg.requestId, msg.payload);
        break;
      }

      case "stream_iteration": {
        // PR-B2: per-iteration boundary marker on the streaming
        // channel. The hub re-projects it to the SSE
        // `event: iteration` channel via the sink's `onIteration`.
        // Older sinks without `onIteration` drop it silently — they
        // are pre-B2 routes and never expect a per-iteration
        // marker, so this is the safe default.
        this.handleStreamIteration(msg.requestId, msg.iteration);
        break;
      }

      case "stream_end": {
        this.handleStreamEnd(msg.requestId);
        break;
      }

      case "invite_minted": {
        // PR #11: the runtime replied to an `invite_mint` request
        // with a signed token. Forward verbatim to the route handler
        // that is awaiting this requestId.
        this.handleInviteMinted(msg.requestId, msg);
        break;
      }

      case "invite_revoked": {
        this.handleInviteRevoked(msg.requestId, msg.jti);
        break;
      }

      case "instance_announce": {
        await this.handleInstanceAnnounce(conn.runtimeId, msg.payload);
        break;
      }

      case "instance_heartbeat": {
        await this.handleInstanceHeartbeat(conn.runtimeId, msg.payload);
        break;
      }

      case "principal_transfer": {
        await this.handlePrincipalTransfer(conn.runtimeId, msg);
        break;
      }

      case "instance_deregister": {
        await this.handleInstanceDeregister(conn.runtimeId, msg.payload);
        break;
      }

      case "status_update": {
        await this.handleStatusUpdate(conn.runtimeId, msg.payload);
        break;
      }

      case "tunnel_channel_event": {
        // peko-channel cross-runtime PR-C: forward channel events
        // (Posted / MemberJoined / MemberLeft / Created) from one
        // runtime to another. The hub is pure relay — it reads only
        // `sourceRuntimeId` (source allowlist) and
        // `recipientRuntimeId` (routing). The `event` payload +
        // signature are forwarded verbatim so the recipient
        // verifies end-to-end.
        await this.handleChannelEventForward(conn, msg);
        break;
      }

      case "tunnel_channel_invite": {
        // peko-channel cross-runtime PR-3a-followup: forward
        // channel invites from a creator runtime to an invitee's
        // hosting runtime. Same pure-relay shape as the
        // channel-event path: source allowlist + recipient lookup
        // + forward verbatim. The `initialMembers` snapshot +
        // `creator` + `name` + `signature` are forwarded verbatim
        // so the recipient can verify end-to-end and bootstrap
        // its local mirror via `ChannelStore::join_remote` (no
        // follow-up `peek` round-trip needed).
        await this.handleChannelInviteForward(conn, msg);
        break;
      }

      case "disconnect": {
        this.fastify.log.info(
          { runtimeId: conn.runtimeId, reason: msg.reason },
          "Runtime sent disconnect",
        );
        this.closeConnection(conn, msg.reason);
        break;
      }

      case "runtime_hello":
      case "tunnel_challenge":
      case "tunnel_challenge_ack":
      case "tunnel_ready":
      case "heartbeat_ack":
      case "proxied_request":
      case "exposure_update":
      case "status_update":
      case "invite_mint":
      case "invite_revoke": {
        // Server-originated only — the runtime should not be sending
        // these. The list above is the *exhaustive* set of server-only
        // types (per the `TunnelMessage` union); if a new
        // server-originated type is added to the union, this list must
        // be updated (the `never` check below catches the gap at
        // compile time).
        //
        // (Handshake-only types `tunnel_challenge` and
        // `tunnel_challenge_ack` are filtered out by the phase checks
        // in `handleSocket`, but listing them here is defensive — if
        // the handshake logic ever changes, we still log a warning
        // instead of crashing on the `never` cast.)
        this.fastify.log.warn(
          { type: msg.type, runtimeId: conn.runtimeId },
          "Unexpected tunnel message direction from runtime",
        );
        break;
      }

      case "principal_registration_rejected":
      case "principal_unlinked":
      case "principal_transfer_rejected":
      case "principal_owner_changed":
      case "principal_registered": return; // Hub-to-runtime receipts; never accepted from a runtime.
      default: {
        // Exhaustiveness fallback: any unhandled runtime-originated
        // type lands here. If the union grows, this branch is the
        // signal that we forgot to handle it above (the compiler
        // narrows `msg` to `never` once the cases above are exhaustive).
        const _exhaustive: never = msg;
        this.fastify.log.warn(
          { type: (_exhaustive as TunnelMessage).type, runtimeId: conn.runtimeId },
          "Unknown tunnel message type from runtime",
        );
        break;
      }
    }
  }

  private handleProxiedResponse(requestId: string, payload: number[]): void {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return;

    try {
      const text = Buffer.from(payload).toString("utf8");
      const parsed = JSON.parse(text) as { status?: number; body?: unknown };
      pending.resolve({
        status: parsed.status ?? 200,
        body: parsed.body ?? null,
      });
    } catch {
      // Fallback: treat raw bytes as body
      pending.resolve({
        status: 200,
        body: Buffer.from(payload).toString("utf8"),
      });
    }

    this.pendingRequests.delete(requestId);
    const conn = connForRequestId(this.connections, requestId);
    conn?.pendingRequestIds.delete(requestId);
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
  }

  /**
   * PR-B2: forward a per-iteration boundary to the active stream
   * sink. No-op if the pending request has no sink, no
   * `onIteration` hook, or has already completed. We do NOT
   * call `pending.reject`/`pending.resolve` here — iteration
   * markers are content-free metadata and the stream keeps
   * going until `stream_end` lands.
   */
  private handleStreamIteration(requestId: string, iteration: number): void {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return;
    if (!pending.streamSink?.onIteration) return;
    try {
      pending.streamSink.onIteration(iteration);
    } catch (err) {
      pending.streamSink.onError(
        err instanceof Error ? err : new Error(String(err)),
      );
      this.rejectRequest(requestId, new Error("Stream sink error"));
    }
  }

  private handleStreamChunk(requestId: string, payload: number[]): void {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return;

    const chunk = Buffer.from(payload).toString("utf8");

    // Activity on this stream — push back the idle timeout so an actively
    // streaming response is never killed mid-flight.
    pending.resetIdleTimer?.();

    if (pending.streamSink) {
      pending.receivedStreamInit = true;
      try {
        pending.streamSink.onChunk(chunk);
      } catch (err) {
        pending.streamSink.onError(
          err instanceof Error ? err : new Error(String(err)),
        );
        this.rejectRequest(requestId, new Error("Stream sink error"));
      }
    } else {
      pending.receivedStreamInit = true;
      pending.chunks.push(chunk);
    }

    const conn = connForRequestId(this.connections, requestId);
    conn?.pendingRequestIds.delete(requestId);
  }

  private handleStreamEnd(requestId: string): void {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return;

    if (pending.streamSink) {
      try {
        pending.streamSink.onEnd();
      } catch (err) {
        pending.streamSink.onError(
          err instanceof Error ? err : new Error(String(err)),
        );
      }
      pending.resolve({ status: 200, body: null });
      this.pendingRequests.delete(requestId);
      const conn = connForRequestId(this.connections, requestId);
      conn?.pendingRequestIds.delete(requestId);
      if (pending.timer) clearTimeout(pending.timer);
      return;
    }

    // Non-streaming fallback: concatenate chunks and resolve
    const body = pending.chunks.length > 0 ? pending.chunks.join("") : "";
    pending.resolve({ status: 200, body });
    this.pendingRequests.delete(requestId);
    const conn = connForRequestId(this.connections, requestId);
    conn?.pendingRequestIds.delete(requestId);
    if (pending.timer) clearTimeout(pending.timer);
  }

  async resolveRuntimeOwner(runtimeId: string): Promise<string | null> {
    // Post-H3: ownerId is a UUID string (was number).
    const row = await db.query.runtimes.findFirst({
      where: eq(runtimes.runtimeDid, runtimeId),
    });
    return row?.ownerId ?? null;
  }

  /**
   * ADR-058 D4: verify the announce's `principalPop` — a compact JWS
   * over canonical JSON `{"runtimeId","principalDid","iat","exp"}`
   * signed with the PRINCIPAL's key. Guards the directory against a
   * runtime asserting a `principalDid` it does not control
   * (directory poisoning).
   *
   * Returns true iff: the JWS verifies against the key embedded in
   * `payload.principalDid` (a did:key), the payload's `runtimeId`
   * matches the announcing connection's runtimeId, `principalDid`
   * matches the announce field, and `iat`/`exp` are fresh
   * (`exp` + 30s leeway, `iat` ≤ now + 60s).
   */
  private async verifyPrincipalPop(
    runtimeId: string,
    payload: InstanceAnnouncePayload,
  ): Promise<boolean> {
    const principalDid = payload.principalDid!;
    if (!payload.principalPop) {
      this.fastify.log.warn(
        { runtimeId, instanceId: payload.id, principalDid },
        "Announce rejected: did:key principalDid without principalPop",
      );
      return false;
    }
    const claims = await verifyDidKeyJws(principalDid, payload.principalPop);
    if (claims === null) {
      this.fastify.log.warn(
        { runtimeId, instanceId: payload.id, principalDid },
        "Announce rejected: principalPop JWS did not verify",
      );
      return false;
    }
    if (claims.runtimeId !== runtimeId || claims.principalDid !== principalDid) {
      this.fastify.log.warn(
        {
          runtimeId,
          instanceId: payload.id,
          principalDid,
          claimedRuntimeId: claims.runtimeId,
        },
        "Announce rejected: principalPop claims mismatch",
      );
      return false;
    }
    const now = Math.floor(Date.now() / 1000);
    const { iat, exp } = claims;
    if (
      typeof iat !== "number" ||
      typeof exp !== "number" ||
      exp + PRINCIPAL_POP_EXP_LEEWAY_SECS < now ||
      iat > now + PRINCIPAL_POP_IAT_LEEWAY_SECS
    ) {
      this.fastify.log.warn(
        { runtimeId, instanceId: payload.id, principalDid, iat, exp },
        "Announce rejected: principalPop stale or future-dated",
      );
      return false;
    }
    return true;
  }

  private async handleInstanceAnnounce(
    runtimeId: string,
    payload: InstanceAnnouncePayload,
  ): Promise<void> {
    const reject = (message: string) => {
      const connection=this.connections.get(runtimeId);
      if (payload.registrationId && connection) this.sendMessage(connection.socket, {type: "principal_registration_rejected", registrationId: payload.registrationId, message});
    };
    // The handshake allowlist (beginHandshake) guarantees a row
    // exists for this DID by the time we reach this code path.
    // resolveRuntimeOwner is a single indexed PK lookup so we keep
    // the defensive check — if it ever returns null, that's a
    // schema-rotation bug we want logged, not silently mis-routed.
    const ownerId = await this.resolveRuntimeOwner(runtimeId);
    if (ownerId === null) {
      this.fastify.log.error(
        { runtimeId, instanceId: payload.id },
        "Allowlisted runtime missing from runtimes table; skipping instance upsert",
      );
      reject("Runtime owner is unavailable");
      return;
    }

    if (payload.exposure === "local_only" || !payload.localId || !payload.identityKey || !payload.principalDid?.startsWith("did:key:")) {
      reject("Registration requires local ID, immutable identity key, signing DID, and private or public visibility");
      return;
    }
    if (!(await this.verifyPrincipalPop(runtimeId, payload))) {
      reject("Principal signing proof is invalid");
      return;
    }
    if (!payload.registrationId) {
      const known = await db.query.hubPrincipals.findFirst({where: eq(hubPrincipals.signingDid, payload.principalDid)});
      if (!known) { reject("Initial registration requires an explicit request ID"); return; }
    }
    let hubId: string;
    try {
      hubId = await instanceService.registerIdentity(payload.principalDid, payload.identityKey);
    } catch (err) {
      reject("Signing identity and immutable actor key belong to different principals");
      this.fastify.log.warn({ err, runtimeId }, "Principal identity registration rejected");
      return;
    }
    const principalDidVerified = true;
    // ADR-081 D4: an online principal's owner is a Hub user, and the Hub's
    // record of it is authoritative. An announce never changes the owner:
    // only a transfer by the recorded owner does. A runtime whose local
    // owner disagrees is told the recorded owner and must re-announce.
    const announcedOwner =
      payload.owner?.kind === "user" && payload.owner.id ? String(payload.owner.id) : null;
    if (announcedOwner === null) {
      reject("An online principal's owner must be a Hub user");
      return;
    }
    const recorded = await instanceService.getByHubId(hubId);
    const recordedOwner =
      recorded?.ownerSubject?.kind === "user" ? String(recorded.ownerSubject.id) : null;
    const staleCopy = !payload.registrationId && recorded !== null && recorded.runtimeId !== runtimeId;
    if (recorded && recordedOwner !== announcedOwner && !staleCopy) {
      reject(
        "This principal's owner on PekoHub differs from the runtime's; " +
          "ownership of an online principal changes only by a PekoHub transfer",
      );
      if (recorded.runtimeId === runtimeId && recordedOwner !== null) {
        this.notifyOwnerChanged(runtimeId, payload.localId, hubId, recordedOwner);
      }
      this.fastify.log.warn(
        { runtimeId, hubId, recordedOwner, announcedOwner },
        "Announce rejected: owner differs from the Hub record",
      );
      return;
    }
    if (!recorded && announcedOwner !== String(ownerId)) {
      // First registration under another account's ownership needs that
      // account's consent; key possession and the runtime account are
      // not enough.
      const consented =
        payload.registrationId !== undefined &&
        (await instanceService.consumeMoveApproval(hubId, runtimeId, announcedOwner));
      if (!consented) {
        reject(
          "The principal's owner must approve putting it online on this runtime " +
            `(POST /v1/principals/by-hub-id/${hubId}/move with {"runtimeId": "${runtimeId}"})`,
        );
        return;
      }
    }
    // ADR-081 D7: one online copy. A principal linked to another runtime
    // moves here only on an explicit registration approved by its owner's
    // account — implicitly when that account also owns this runtime. Key
    // possession alone cannot decide: every copy holds the key.
    const linked = await instanceService.findLinkedElsewhere(hubId, runtimeId);
    if (linked) {
      const owner = linked.ownerSubject?.kind === "user" ? linked.ownerSubject.id : null;
      const approved =
        owner !== null &&
        payload.registrationId !== undefined &&
        (owner === String(ownerId) ||
          (await instanceService.consumeMoveApproval(hubId, runtimeId, owner)));
      if (payload.registrationId === undefined) {
        // A stale copy reconnecting after a move: tell it it is offline.
        const connection = this.connections.get(runtimeId);
        if (connection) {
          this.sendMessage(connection.socket, {
            type: "principal_unlinked",
            localId: payload.localId,
            hubId,
          });
        }
        return;
      }
      if (!approved) {
        reject(
          "This principal is online on another runtime; its owner must approve the move " +
            `(POST /v1/principals/by-hub-id/${hubId}/move)`,
        );
        return;
      }
      await instanceService.delete(linked.id);
      const previous = this.connections.get(linked.runtimeId);
      if (previous && linked.localId) {
        this.sendMessage(previous.socket, {
          type: "principal_unlinked",
          localId: linked.localId,
          hubId,
        });
      }
      this.fastify.log.info(
        { hubId, from: linked.runtimeId, to: runtimeId },
        "Principal online link moved",
      );
    }
    // ADR-056 D7: at most one publicly exposed instance per
    // principal DID network-wide. A runtime announcing a public /
    // unlisted instance for a DID that ANOTHER instance already
    // serves publicly is rejected — the same rule the exposure PATCH
    // enforces on the HTTP side.
    if (
      (payload.exposure === "public") &&
      payload.principalDid
    ) {
      const conflict = await instanceService.findPublicExposureConflict(
        payload.principalDid,
        payload.id,
      );
      if (conflict) {
        this.fastify.log.warn(
          {
            runtimeId,
            instanceId: payload.id,
            hubId,
        localId: payload.localId,
        principalDid: payload.principalDid,
            conflictingInstanceId: conflict.id,
            conflictingInstanceName: conflict.name,
          },
          "Announce rejected: another instance is already publicly exposed for this principal DID (ADR-056 D7)",
        );
        reject("Another runtime already serves this principal publicly");
        return;
      }
    }

    try {
      // Post-H1: instances carry only the typed `owner_subject`
      // (the legacy `owner_id` integer FK is gone). Project the
      // resolved runtime owner into the same `{kind:"user",id:"…"}`
      // shape so `upsertFromAnnounce` doesn't need a backfill shim.
      // ADR-081 D4: an online principal's owner is a Hub account.
      // ADR-081 D4: equal to the Hub's record by the check above.
      const ownerSubject = { kind: "user" as const, id: announcedOwner };
      await instanceService.upsertFromAnnounce({
        id: payload.id,
        type: payload.type,
        name: payload.name,
        ownerSubject,
        runtimeId,
        runtimeDisplayName: payload.runtimeDisplayName,
        bundleRef: payload.bundleRef,
        status: payload.status,
        exposure: payload.exposure,
        // Post-H4: allowedPrincipals removed from the announce payload.
        capabilities: payload.capabilities,
        metadata: payload.metadata,
        // Issue #14: per-principal DID. Pre-#34 runtimes omit the field;
        // the service layer leaves the existing column alone in that
        // case (see `upsertFromAnnounce`).
        principalDid: payload.principalDid,
        // ADR-058 D4: whether `principalDid` was proven via
        // `principalPop` on this announce. `undefined` when the
        // announce carries no DID — same leave-alone semantics.
        principalDidVerified,
        hubId,
        localId: payload.localId,
      });
      if (hubId && payload.localId && payload.principalDid) {
        const connection = this.connections.get(runtimeId);
        if (connection) this.sendMessage(connection.socket, { type: "principal_registered", registrationId: payload.registrationId, localId: payload.localId, hubId, signingDid: payload.principalDid });
      }
    } catch (err) {
      reject("Registration could not be persisted");
      this.fastify.log.warn(
        { err, runtimeId, instanceId: payload.id },
        "Failed to upsert instance from announce",
      );
    }
  }

  /**
   * Ownership guard for instance-tunnel messages. An authenticated
   * tunnel connection may only touch instance rows hosted by its own
   * runtime — without this, any connected runtime could heartbeat /
   * re-status / delete another user's instances (the HTTP routes
   * enforce `isOwner`; these messages had no scoping at all).
   */
  private async instanceOwnedByRuntime(
    runtimeId: string,
    instanceId: string,
  ): Promise<boolean> {
    const instance = await instanceService.getById(instanceId);
    if (!instance || instance.runtimeId !== runtimeId) {
      this.fastify.log.warn(
        { runtimeId, instanceId },
        "Instance-tunnel message rejected: instance not hosted by this runtime",
      );
      return false;
    }
    return true;
  }

  private async handleInstanceHeartbeat(
    runtimeId: string,
    payload: InstanceHeartbeatPayload,
  ): Promise<void> {
    try {
      if (!(await this.instanceOwnedByRuntime(runtimeId, payload.id))) return;
      await instanceService.heartbeat(
        payload.id,
        payload.status as InstanceStatus,
      );
    } catch (err) {
      this.fastify.log.warn(
        { err, runtimeId, instanceId: payload.id },
        "Failed to process instance heartbeat",
      );
    }
  }

  private async handleStatusUpdate(
    runtimeId: string,
    payload: StatusUpdatePayload,
  ): Promise<void> {
    try {
      if (!(await this.instanceOwnedByRuntime(runtimeId, payload.instanceId)))
        return;
      await instanceService.update(payload.instanceId, {
        status: payload.status,
      });
    } catch (err) {
      this.fastify.log.warn(
        { err, instanceId: payload.instanceId },
        "Failed to process status update",
      );
    }
  }

  private async handleInstanceDeregister(
    runtimeId: string,
    payload: InstanceDeregisterPayload,
  ): Promise<void> {
    try {
      if (!(await this.instanceOwnedByRuntime(runtimeId, payload.id))) return;
      await instanceService.delete(payload.id);
    } catch (err) {
      this.fastify.log.warn(
        { err, instanceId: payload.id },
        "Failed to deregister instance",
      );
    }
  }

  /**
   * Look up the live `RuntimeConnection` for a runtime. Returns
   * `undefined` if the runtime isn't connected or its socket is no
   * longer OPEN (heartbeat timeout, disconnect mid-flight, etc.).
   *
   * Public so tests (and any future HTTP handler that needs to know
   * if a runtime is reachable) can ask without poking at the
   * `connections` map directly.
   */
  getConnection(runtimeId: string): RuntimeConnection | undefined {
    const conn = this.connections.get(runtimeId);
    if (!conn) return undefined;
    if (conn.socket.readyState !== conn.socket.OPEN) return undefined;
    return conn;
  }

  // ── Cross-runtime channel event forwarding (peko-channel PR-C) ──────────
  //
  // Mirrors `handlePrincipalToPrincipalRequest` in shape: source
  // allowlist + recipient lookup + forward verbatim. Channel events
  // are push-only (no request/response), so this method has no
  // in-flight registry, no response correlation, no synthesized
  // error envelopes. The recipient runtime either is connected
  // (forward) or isn't (drop + count + log).
  //
  // Hub is pure relay: no channel-membership state consulted.
  // The runtime-side `fanout_event` emits one envelope per
  // unique recipient runtime; the hub routes each to its
  // corresponding `connections.get(recipientRuntimeId)`.

  private async handleChannelEventForward(
    conn: RuntimeConnection,
    msg: Extract<TunnelMessage, { type: "tunnel_channel_event" }>,
  ): Promise<void> {
    // 1. Source allowlist. Same defense-in-depth as the DM path:
    //    the receiving tunnel's authenticated `runtimeId` must match
    //    the envelope's claim, otherwise a runtime is impersonating
    //    another. Close + log; no error reply is sent (channel
    //    events have no response channel).
    if (conn.runtimeId !== msg.sourceRuntimeId) {
      metrics.inc(CounterName.HubChannelEventRejectedSourceAllowlist);
      this.fastify.log.warn(
        {
          connRuntime: conn.runtimeId,
          claim: msg.sourceRuntimeId,
          requestId: msg.requestId,
          channelId: msg.channelId,
        },
        "channel event source allowlist mismatch — closing tunnel (impersonation)",
      );
      this.closeConnection(conn, "source allowlist mismatch");
      this.handleDisconnect(conn);
      return;
    }

    // 1b. ADR-081 D7: a registered principal speaks only from the runtime
    //     its online link points at. An offline copy elsewhere holds the
    //     same key, so the signature alone cannot tell them apart. An
    //     unregistered author is left to the receiving runtime, which
    //     checks registration end to end.
    if (msg.sourcePrincipalDid.startsWith("did:key:")) {
      const linked = await instanceService.linkedRuntimeForSigningDid(msg.sourcePrincipalDid);
      if (linked !== undefined && linked !== conn.runtimeId) {
        this.fastify.log.warn(
          { connRuntime: conn.runtimeId, linkedRuntime: linked, principal: msg.sourcePrincipalDid },
          "dropping envelope from a principal not linked to this runtime",
        );
        return;
      }
    }

    // 2. Recipient lookup. `connections.get(recipientRuntimeId)`
    //    returns `undefined` if the runtime isn't currently
    //    connected (and `getConnection` also filters out sockets
    //    that are no longer OPEN). Drop + count + log; the source
    //    runtime will retry on the next event or a tunnel
    //    reconnect — channel events are push-only and there is no
    //    no-response-to-send path.
    const targetConn = this.getConnection(msg.recipientRuntimeId);
    if (!targetConn) {
      metrics.inc(CounterName.HubChannelEventRecipientOffline);
      this.fastify.log.warn(
        {
          sourceRuntime: conn.runtimeId,
          recipientRuntime: msg.recipientRuntimeId,
          channelId: msg.channelId,
          requestId: msg.requestId,
        },
        "channel event recipient runtime offline — dropping",
      );
      return;
    }

    // 3. Forward — relay the envelope verbatim, including
    //    `signature` and `event`. The recipient verifies
    //    end-to-end against the source runtime's `source_runtime_id`
    //    derived verifying key. Hub does NOT re-encode or re-sign.
    metrics.inc(CounterName.HubChannelEventForwarded);
    this.sendMessage(targetConn.socket, msg);
  }

  // ── Cross-runtime channel invite forwarding (peko-channel PR-3a-followup) ─
  //
  // Mirrors `handleChannelEventForward` in shape: source allowlist
  // + recipient lookup + forward verbatim. Channel invites are
  // push-only (no request/response), so this method has no
  // in-flight registry, no response correlation, no synthesized
  // error envelopes. The recipient runtime either is connected
  // (forward) or isn't (drop + count + log).
  //
  // Hub is pure relay: no channel-membership state consulted.
  // The runtime-side `fanout_invite` emits one envelope per
  // unique invitee runtime; the hub routes each to its
  // corresponding `connections.get(recipientRuntimeId)`.

  private async handleChannelInviteForward(
    conn: RuntimeConnection,
    msg: Extract<TunnelMessage, { type: "tunnel_channel_invite" }>,
  ): Promise<void> {
    // 1. Source allowlist. Same defense-in-depth as the channel-event
    //    path: the receiving tunnel's authenticated `runtimeId` must
    //    match the envelope's claim, otherwise a runtime is
    //    impersonating another. Close + log; no error reply is sent
    //    (invites have no response channel).
    if (conn.runtimeId !== msg.sourceRuntimeId) {
      metrics.inc(CounterName.HubChannelInviteRejectedSourceAllowlist);
      this.fastify.log.warn(
        {
          connRuntime: conn.runtimeId,
          claim: msg.sourceRuntimeId,
          requestId: msg.requestId,
          channelId: msg.channelId,
        },
        "channel invite source allowlist mismatch — closing tunnel (impersonation)",
      );
      this.closeConnection(conn, "source allowlist mismatch");
      this.handleDisconnect(conn);
      return;
    }

    // 1b. ADR-081 D7: a registered principal speaks only from the runtime
    //     its online link points at. An offline copy elsewhere holds the
    //     same key, so the signature alone cannot tell them apart. An
    //     unregistered author is left to the receiving runtime, which
    //     checks registration end to end.
    if (msg.sourcePrincipalDid.startsWith("did:key:")) {
      const linked = await instanceService.linkedRuntimeForSigningDid(msg.sourcePrincipalDid);
      if (linked !== undefined && linked !== conn.runtimeId) {
        this.fastify.log.warn(
          { connRuntime: conn.runtimeId, linkedRuntime: linked, principal: msg.sourcePrincipalDid },
          "dropping envelope from a principal not linked to this runtime",
        );
        return;
      }
    }

    // 2. Recipient lookup. `connections.get(recipientRuntimeId)`
    //    returns `undefined` if the runtime isn't currently
    //    connected. Drop + count + log; the source runtime will
    //    retry on the next invite or a tunnel reconnect — invites
    //    are push-only and there is no response-to-send path.
    const targetConn = this.getConnection(msg.recipientRuntimeId);
    if (!targetConn) {
      metrics.inc(CounterName.HubChannelInviteRecipientOffline);
      this.fastify.log.warn(
        {
          sourceRuntime: conn.runtimeId,
          recipientRuntime: msg.recipientRuntimeId,
          channelId: msg.channelId,
          requestId: msg.requestId,
        },
        "channel invite recipient runtime offline — dropping",
      );
      return;
    }

    // 3. Forward — relay the envelope verbatim, including
    //    `signature`, `creator`, `name`, and the full
    //    `initialMembers` snapshot. The recipient verifies
    //    end-to-end against the source runtime's
    //    `source_runtime_id`-derived verifying key (domain tag
    //    `channel-invite:v1`). Hub does NOT re-encode or
    //    re-sign.
    metrics.inc(CounterName.HubChannelInviteForwarded);
    this.sendMessage(targetConn.socket, msg);
  }

    private handleDisconnect(conn: RuntimeConnection): void {
    if (conn.heartbeatTimeout) {
      clearTimeout(conn.heartbeatTimeout);
      conn.heartbeatTimeout = null;
    }

    // Reject pending requests
    for (const requestId of conn.pendingRequestIds) {
      this.rejectRequest(requestId, new Error("Tunnel disconnected"));
    }
    conn.pendingRequestIds.clear();


    if (this.connections.get(conn.runtimeId) === conn) {
      this.connections.delete(conn.runtimeId);
    }

    // Mark hosted instances offline and propagate via tunnel if still connected
    this.propagateRuntimeOffline(conn).catch((err) => {
      this.fastify.log.warn(
        { err, runtimeId: conn.runtimeId },
        "Failed to mark runtime offline",
      );
    });

    this.fastify.log.info(
      { runtimeId: conn.runtimeId },
      "Runtime tunnel disconnected",
    );
  }

  /**
   * Tell a principal's linked runtime the owner the Hub records (ADR-081
   * D4): after a transfer, or when it announced a different one.
   */
  notifyOwnerChanged(
    runtimeId: string,
    localId: string,
    hubId: string,
    ownerId: string,
    requestId?: string,
  ): void {
    const connection = this.connections.get(runtimeId);
    if (connection) {
      this.sendMessage(connection.socket, {
        type: "principal_owner_changed",
        requestId,
        localId,
        hubId,
        ownerId,
      });
    }
  }

  /**
   * A runtime transfers a principal it hosts (ADR-081 D4). Allowed when the
   * principal is linked to that runtime and the runtime's account is the
   * recorded owner — the local user at its terminal owns it.
   */
  private async handlePrincipalTransfer(
    runtimeId: string,
    msg: { requestId: string; localId: string; hubId: string; ownerId: string },
  ): Promise<void> {
    const connection = this.connections.get(runtimeId);
    const refuse = (message: string) => {
      if (connection) {
        this.sendMessage(connection.socket, {
          type: "principal_transfer_rejected",
          requestId: msg.requestId,
          message,
        });
      }
    };
    const record = await instanceService.getByHubId(msg.hubId);
    if (!record || record.runtimeId !== runtimeId || record.localId !== msg.localId) {
      refuse("This principal is not online on this runtime");
      return;
    }
    const account = await this.resolveRuntimeOwner(runtimeId);
    if (account === null) {
      refuse("Runtime owner is unavailable");
      return;
    }
    const result = await instanceService.transferOwner(msg.hubId, msg.ownerId, String(account));
    switch (result.status) {
      case "transferred":
        await auditService.logPrincipalOwnerTransfer(msg.hubId, String(account), {
          from: result.previous,
          to: msg.ownerId,
          via: "tunnel",
        });
        this.notifyOwnerChanged(runtimeId, msg.localId, msg.hubId, msg.ownerId, msg.requestId);
        return;
      case "denied":
        refuse("Only the principal's owner on PekoHub can transfer it");
        return;
      case "unknown_user":
        refuse("The new owner is not a PekoHub user");
        return;
      case "miss":
        refuse("This principal is not online on this runtime");
        return;
    }
  }

  /** Close a runtime's tunnel, if connected (e.g. after it unregisters). */
  disconnectRuntime(runtimeId: string, reason: string): void {
    const conn = this.connections.get(runtimeId);
    if (conn) this.closeConnection(conn, reason);
  }

  private closeConnection(conn: RuntimeConnection, reason: string): void {
    if (conn.socket.readyState === conn.socket.OPEN) {
      this.sendMessage(conn.socket, { type: "disconnect", reason });
      conn.socket.close(1000, reason);
    }
  }

  private resetHeartbeatTimeout(conn: RuntimeConnection): void {
    if (conn.heartbeatTimeout) {
      clearTimeout(conn.heartbeatTimeout);
    }
    conn.heartbeatTimeout = setTimeout(() => {
      this.fastify.log.warn(
        { runtimeId: conn.runtimeId },
        "Tunnel heartbeat timeout",
      );
      this.closeConnection(conn, "heartbeat timeout");
      this.handleDisconnect(conn);
    }, HEARTBEAT_TIMEOUT_MS);
    conn.heartbeatTimeout.unref?.();
  }

  private reapStaleConnections(): void {
    const now = Date.now();
    for (const conn of this.connections.values()) {
      if (now - conn.lastHeartbeatAt.getTime() > HEARTBEAT_TIMEOUT_MS) {
        this.fastify.log.warn(
          { runtimeId: conn.runtimeId },
          "Reaping stale tunnel connection",
        );
        this.closeConnection(conn, "heartbeat timeout");
        this.handleDisconnect(conn);
      }
    }
  }

  async sendProxiedRequest(
    runtimeId: string,
    request: HttpProxiedRequest,
    timeoutMs: number = 30_000,
  ): Promise<{ status: number; body: unknown }> {
    const conn = this.connections.get(runtimeId);
    if (!conn || conn.socket.readyState !== conn.socket.OPEN) {
      throw new Error("Runtime not connected");
    }

    return new Promise((resolve, reject) => {
      const pending: PendingRequest = {
        resolve,
        reject,
        receivedStreamInit: false,
        chunks: [],
      };

      this.pendingRequests.set(request.requestId, pending);
      conn.pendingRequestIds.add(request.requestId);

      this.sendMessage(conn.socket, {
        type: "proxied_request",
        requestId: request.requestId,
        principal: request.principalName,
        payload: Array.from(encodeHttpRequestBody(request)),
      });

      const timer = setTimeout(() => {
        if (this.pendingRequests.has(request.requestId)) {
          this.pendingRequests.delete(request.requestId);
          conn.pendingRequestIds.delete(request.requestId);
          reject(new Error("Proxy request timeout"));
        }
      }, timeoutMs);
      timer.unref?.();
      pending.timer = timer;
    });
  }

  async startStream(
    runtimeId: string,
    request: HttpProxiedRequest,
    sink: StreamSink,
    timeoutMs: number = 30_000,
  ): Promise<void> {
    const conn = this.connections.get(runtimeId);
    if (!conn || conn.socket.readyState !== conn.socket.OPEN) {
      throw new Error("Runtime not connected");
    }

    return new Promise((resolve, reject) => {
      const pending: PendingRequest = {
        resolve: (result) => {
          // If resolved without stream init, treat as immediate response.
          // A runtime refusing the request (no chat grant, invalid
          // bridge token, execution failure) answers with a status
          // >= 400: that is an error, not the peko's reply — before,
          // it reached the chat as reply text.
          if (!pending.receivedStreamInit) {
            try {
              if (result.status >= 400) {
                sink.onError(new Error(refusalMessage(result.status, result.body)));
              } else {
                sink.onChunk(String(result.body ?? ""));
                sink.onEnd();
              }
            } catch (err) {
              sink.onError(err instanceof Error ? err : new Error(String(err)));
            }
          }
          try {
            resolve();
          } catch {
            /* already resolved */
          }
        },
        reject: (err) => {
          sink.onError(err);
          reject(err);
        },
        streamSink: sink,
        receivedStreamInit: false,
        chunks: [],
      };

      this.pendingRequests.set(request.requestId, pending);
      conn.pendingRequestIds.add(request.requestId);

      this.sendMessage(conn.socket, {
        type: "proxied_request",
        requestId: request.requestId,
        principal: request.principalName,
        payload: Array.from(encodeHttpRequestBody(request)),
      });

      // Idle timeout: aborts the stream only if no chunk arrives for
      // `timeoutMs`. `armTimer` clears any existing timer and starts a
      // fresh one; `handleStreamChunk` calls it via `resetIdleTimer` on
      // every chunk, so a long-but-active stream is never killed.
      const armTimer = () => {
        if (pending.timer) clearTimeout(pending.timer);
        const timer = setTimeout(() => {
          if (this.pendingRequests.has(request.requestId)) {
            this.pendingRequests.delete(request.requestId);
            conn.pendingRequestIds.delete(request.requestId);
            const err = new Error("Stream request timeout");
            sink.onError(err);
            reject(err);
          }
        }, timeoutMs);
        timer.unref?.();
        pending.timer = timer;
      };
      pending.resetIdleTimer = armTimer;
      armTimer();
    });
  }

  async broadcastControl(
    runtimeId: string,
    message: TunnelMessage,
  ): Promise<void> {
    const conn = this.connections.get(runtimeId);
    if (!conn || conn.socket.readyState !== conn.socket.OPEN) {
      return;
    }
    this.sendMessage(conn.socket, message);
  }

  private async propagateRuntimeOffline(
    conn: RuntimeConnection,
  ): Promise<void> {
    try {
      const rows = await db
        .select({ id: instances.id })
        .from(instances)
        .where(
          and(
            eq(instances.runtimeId, conn.runtimeId),
            inArray(instances.status, ["online", "busy"]),
          ),
        );

      for (const row of rows) {
        if (conn.socket.readyState === conn.socket.OPEN) {
          this.sendMessage(conn.socket, {
            type: "status_update",
            payload: {
              instanceId: row.id,
              status: "offline",
            },
          });
        }
      }
    } catch (err) {
      this.fastify.log.warn(
        { err, runtimeId: conn.runtimeId },
        "Failed to propagate runtime offline status",
      );
    }

    await this.markRuntimeOffline(conn.runtimeId);
  }

  async markRuntimeOffline(runtimeId: string): Promise<void> {
    try {
      // Mark all instances hosted by this runtime as offline in a single bulk UPDATE
      await db
        .update(instances)
        .set({ status: "offline" })
        .where(
          and(
            eq(instances.runtimeId, runtimeId),
            inArray(instances.status, ["online", "busy"]),
          ),
        );
    } catch (err) {
      this.fastify.log.warn(
        { err, runtimeId },
        "Failed to mark runtime instances offline",
      );
    }
  }

  isRuntimeConnected(runtimeId: string): boolean {
    const conn = this.connections.get(runtimeId);
    return !!conn && conn.socket.readyState === conn.socket.OPEN;
  }

  /**
   * PR #11: ask the runtime to mint a signed invite token. Returns
   * the runtime's `invite_minted` payload verbatim. Throws if the
   * runtime is unreachable or doesn't respond within `timeoutMs`.
   */
  async requestInviteMint(
    runtimeId: string,
    principal: string,
    scope: string[],
    ttlSecs: number,
    timeoutMs: number = 15_000,
  ): Promise<{
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
  }> {
    const conn = this.connections.get(runtimeId);
    if (!conn || conn.socket.readyState !== conn.socket.OPEN) {
      throw new Error("Runtime not connected");
    }

    const requestId = crypto.randomUUID();

    return new Promise((resolve, reject) => {
      const pending: PendingRequest = {
        resolve: (result) => {
          const body = result.body as {
            token?: string;
            url?: string;
            claims?: {
              principalDid: string;
              principalName: string;
              ownerSubject: string;
              scope: string[];
              exp: number;
              jti: string;
            };
          } | null;
          if (
            !body ||
            typeof body.token !== "string" ||
            typeof body.url !== "string" ||
            !body.claims
          ) {
            reject(
              new Error(
                `Runtime returned malformed invite_minted payload: ${JSON.stringify(body)}`,
              ),
            );
            return;
          }
          resolve({
            token: body.token,
            url: body.url,
            claims: body.claims,
          });
        },
        reject,
        receivedStreamInit: false,
        chunks: [],
      };
      this.pendingRequests.set(requestId, pending);
      conn.pendingRequestIds.add(requestId);

      const timer = setTimeout(() => {
        if (this.pendingRequests.has(requestId)) {
          this.pendingRequests.delete(requestId);
          conn.pendingRequestIds.delete(requestId);
          reject(new Error("Invite mint request timeout"));
        }
      }, timeoutMs);
      timer.unref?.();
      pending.timer = timer;

      this.sendMessage(conn.socket, {
        type: "invite_mint",
        requestId,
        principal,
        scope,
        ttlSecs,
      });
    });
  }

  /**
   * PR #11: ask the runtime to burn a `jti`. The runtime's
   * in-memory `InviteRevocationSet` is the source of truth — once
   * it acks, every subsequent request presenting that token is
   * rejected. Throws on runtime unreachable / timeout.
   */
  async requestInviteRevoke(
    runtimeId: string,
    principal: string,
    jti: string,
    timeoutMs: number = 15_000,
  ): Promise<void> {
    const conn = this.connections.get(runtimeId);
    if (!conn || conn.socket.readyState !== conn.socket.OPEN) {
      throw new Error("Runtime not connected");
    }

    const requestId = crypto.randomUUID();

    return new Promise<void>((resolve, reject) => {
      const pending: PendingRequest = {
        resolve: () => resolve(),
        reject,
        receivedStreamInit: false,
        chunks: [],
      };
      this.pendingRequests.set(requestId, pending);
      conn.pendingRequestIds.add(requestId);

      const timer = setTimeout(() => {
        if (this.pendingRequests.has(requestId)) {
          this.pendingRequests.delete(requestId);
          conn.pendingRequestIds.delete(requestId);
          reject(new Error("Invite revoke request timeout"));
        }
      }, timeoutMs);
      timer.unref?.();
      pending.timer = timer;

      this.sendMessage(conn.socket, {
        type: "invite_revoke",
        requestId,
        principal,
        jti,
      });
    });
  }

  private handleInviteMinted(
    requestId: string,
    msg: Extract<TunnelMessage, { type: "invite_minted" }>,
  ): void {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return;
    this.pendingRequests.delete(requestId);
    const conn = connForRequestId(this.connections, requestId);
    conn?.pendingRequestIds.delete(requestId);
    if (pending.timer) clearTimeout(pending.timer);
    pending.resolve({
      status: 200,
      body: {
        token: msg.token,
        url: msg.url,
        claims: msg.claims,
      },
    });
  }

  private handleInviteRevoked(requestId: string, jti: string): void {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return;
    this.pendingRequests.delete(requestId);
    const conn = connForRequestId(this.connections, requestId);
    conn?.pendingRequestIds.delete(requestId);
    if (pending.timer) clearTimeout(pending.timer);
    pending.resolve({
      status: 200,
      body: { jti },
    });
  }

  private sendMessage(socket: WebSocket, msg: TunnelMessage): void {
    if (socket.readyState === socket.OPEN) {
      socket.send(encodeTunnelMessage(msg));
    }
  }

  private rejectRequest(requestId: string, error: Error): void {
    const pending = this.pendingRequests.get(requestId);
    if (pending) {
      this.pendingRequests.delete(requestId);
      pending.reject(error);
    }
  }
}

function connForRequestId(
  connections: Map<string, RuntimeConnection>,
  requestId: string,
): RuntimeConnection | undefined {
  for (const conn of connections.values()) {
    if (conn.pendingRequestIds.has(requestId)) return conn;
  }
  return undefined;
}

function encodeHttpRequestBody(request: HttpProxiedRequest): Buffer {
  return Buffer.from(
    JSON.stringify({
      requestId: request.requestId,
      instanceId: request.instanceId,
      method: request.method,
      body: request.body,
      headers: request.headers,
    }),
    "utf8",
  );
}

export { HEARTBEAT_INTERVAL_SECS, HEARTBEAT_TIMEOUT_MS, LIVE_CONNECTION_WINDOW_MS };
