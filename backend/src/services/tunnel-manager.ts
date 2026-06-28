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
import { verifyDidKeySignature, TunnelAuthError } from "./tunnel-crypto.js";
import {
  instanceService,
  subjectCanAccess,
  resolveOwnerSubject,
  type InstanceStatus,
} from "./instances.js";
import { metrics, CounterName } from "./metrics.js";
import type { Subject } from "@pekohub/shared";
import { db } from "../db/index.js";
import { runtimes, instances } from "../db/schema.js";
import { eq, inArray, and } from "drizzle-orm";

const HELLO_TIMEOUT_MS = 10_000;
const CHALLENGE_TIMEOUT_MS = 10_000;
const HEARTBEAT_INTERVAL_SECS = 30;
const HEARTBEAT_TIMEOUT_MS = 90_000;
const REAPER_INTERVAL_MS = 30_000;
const CHALLENGE_NONCE_BYTES = 32;
/** TTL for an in-flight cross-runtime a2a request. Matches the
 *  proxyChat default (30s) and is what the issue specifies. */
const A2A_IN_FLIGHT_TTL_MS = 30_000;

/** Options bag for `TunnelManager`. Currently only the a2a TTL is
 *  exposed, for test injection. Production callers leave it alone. */
export interface TunnelManagerOptions {
  /** Override the in-flight a2a request TTL (default 30s). Tests
   *  use a small value to avoid waiting 30s in the timeout case. */
  a2aInFlightTtlMs?: number;
}

/** Phases of the runtime-side handshake. */
type HandshakePhase = "hello" | "challenge" | "ready";

export interface PendingRequest {
  resolve: (value: { status: number; body: unknown }) => void;
  reject: (reason: Error) => void;
  streamSink?: StreamSink;
  receivedStreamInit: boolean;
  chunks: string[];
  timer?: NodeJS.Timeout;
}

export interface StreamSink {
  onChunk: (chunk: string) => void;
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

/**
 * Cross-runtime a2a correlation entry (issue #16). Mirrors the
 * `pendingRequests` pattern for proxyChat: keyed by `requestId`,
 * carries both sockets so a response can be relayed back AND the
 * target can be notified if the caller disappears mid-flight, plus a
 * TTL timer so a non-responsive target doesn't leak entries.
 */
interface A2AInFlightEntry {
  callerRuntimeId: string;
  callerSocket: WebSocket;
  targetRuntimeId: string;
  targetSocket: WebSocket;
  timer: NodeJS.Timeout;
}

/**
 * Codes for synthesized error responses (issue #16). The runtime decodes
 * the `payload` JSON `{ kind: "error", code, message }` and surfaces the
 * error to the original `a2a_send` caller.
 */
export type A2AErrorCode =
  | "target_not_found"
  | "target_offline"
  | "forbidden"
  | "timeout"
  | "internal_error";

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

  /** Issue #16: in-flight cross-runtime a2a requests, keyed by requestId. */
  private a2aInFlight = new Map<string, A2AInFlightEntry>();
  /** Issue #16: configurable TTL (constructor-injected for tests). */
  private readonly a2aInFlightTtlMs: number;

  constructor(
    private fastify: FastifyInstance,
    opts: TunnelManagerOptions = {},
  ) {
    this.a2aInFlightTtlMs = opts.a2aInFlightTtlMs ?? A2A_IN_FLIGHT_TTL_MS;
  }

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

    // 3. Replace any pre-existing connection for this runtime.
    const existing = this.connections.get(runtimeId);
    if (existing) {
      this.fastify.log.info(
        { runtimeId },
        "Replacing existing tunnel connection",
      );
      this.closeConnection(existing, "new connection from same runtime");
    }

    // 4. Issue a fresh, server-generated nonce and remember it for
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

      case "stream_end": {
        this.handleStreamEnd(msg.requestId);
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

      case "instance_deregister": {
        await this.handleInstanceDeregister(conn.runtimeId, msg.payload);
        break;
      }

      case "status_update": {
        await this.handleStatusUpdate(conn.runtimeId, msg.payload);
        break;
      }

      case "principal_to_principal_request": {
        await this.handleAgentToAgentRequest(conn, msg);
        break;
      }

      case "principal_to_principal_response": {
        this.handleAgentToAgentResponse(conn, msg);
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
      case "exposure_update": {
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

  private handleStreamChunk(requestId: string, payload: number[]): void {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return;

    const chunk = Buffer.from(payload).toString("utf8");

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

  async resolveRuntimeOwner(runtimeId: string): Promise<number | null> {
    const row = await db.query.runtimes.findFirst({
      where: eq(runtimes.runtimeDid, runtimeId),
    });
    return row?.ownerId ?? null;
  }

  private async handleInstanceAnnounce(
    runtimeId: string,
    payload: InstanceAnnouncePayload,
  ): Promise<void> {
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
      return;
    }

    try {
      await instanceService.upsertFromAnnounce({
        id: payload.id,
        type: payload.type,
        name: payload.name,
        ownerId,
        // Issue #11: typed owner from the runtime. When absent
        // (pre-#11 runtime), the service layer backfills from
        // `ownerId` via `Principal::User(ownerId)`.
        ownerSubject: payload.owner ?? null,
        runtimeId,
        runtimeDisplayName: payload.runtimeDisplayName,
        bundleRef: payload.bundleRef,
        status: payload.status,
        exposure: payload.exposure,
        allowedPrincipals: payload.allowedPrincipals,
        capabilities: payload.capabilities,
        metadata: payload.metadata,
        // Issue #14: per-agent DID. Pre-#34 runtimes omit the field;
        // the service layer leaves the existing column alone in that
        // case (see `upsertFromAnnounce`).
        principalDid: payload.principalDid,
      });
    } catch (err) {
      this.fastify.log.warn(
        { err, runtimeId, instanceId: payload.id },
        "Failed to upsert instance from announce",
      );
    }
  }

  private async handleInstanceHeartbeat(
    runtimeId: string,
    payload: InstanceHeartbeatPayload,
  ): Promise<void> {
    try {
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
    _runtimeId: string,
    payload: StatusUpdatePayload,
  ): Promise<void> {
    try {
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
    _runtimeId: string,
    payload: InstanceDeregisterPayload,
  ): Promise<void> {
    try {
      await instanceService.delete(payload.id);
    } catch (err) {
      this.fastify.log.warn(
        { err, instanceId: payload.id },
        "Failed to deregister instance",
      );
    }
  }

  // ── Cross-runtime a2a forwarding (issue #16) ─────────────────────────────

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

  /**
   * Synthesize and send an `principal_to_principal_response` carrying a JSON
   * `{ kind: "error", code, message }` payload. The runtime decodes it
   * and surfaces the error to the `a2a_send` caller.
   */
  private sendA2AErrorResponse(
    socket: WebSocket,
    requestId: string,
    code: A2AErrorCode,
    message: string,
  ): void {
    if (socket.readyState !== socket.OPEN) return;
    const payload = JSON.stringify({ kind: "error", code, message });
    this.sendMessage(socket, {
      type: "principal_to_principal_response",
      requestId,
      payload,
    });
  }

  private async handleAgentToAgentRequest(
    conn: RuntimeConnection,
    req: Extract<TunnelMessage, { type: "principal_to_principal_request" }>,
  ): Promise<void> {
    // 1. Source allowlist — the receiving tunnel's authenticated
    //    `runtimeId` must match the envelope's claim. Otherwise a
    //    runtime is impersonating another (P0-class incident: a
    //    runtime can sign with its own key but claim to be sending on
    //    behalf of someone else's DID). Close + log; no error reply
    //    is sent to the impersonator.
    if (conn.runtimeId !== req.callerRuntimeId) {
      metrics.inc(CounterName.HubA2ARejectedSourceAllowlist);
      this.fastify.log.warn(
        {
          connRuntime: conn.runtimeId,
          claim: req.callerRuntimeId,
          requestId: req.requestId,
        },
        "a2a source allowlist mismatch — closing tunnel (impersonation)",
      );
      this.closeConnection(conn, "source allowlist mismatch");
      this.handleDisconnect(conn);
      return;
    }

    // 2. Target lookup — resolve the target agent DID to a host
    //    runtime via the directory API (#14). 404-ish: synthesize a
    //    structured error response so the runtime doesn't hang.
    const target = await instanceService.getByDid(req.targetPrincipalDid);
    if (!target) {
      metrics.inc(CounterName.HubA2ATargetMissing);
      this.fastify.log.warn(
        {
          callerRuntime: conn.runtimeId,
          targetPrincipalDid: req.targetPrincipalDid,
          requestId: req.requestId,
        },
        "a2a target not found",
      );
      this.sendA2AErrorResponse(
        conn.socket,
        req.requestId,
        "target_not_found",
        `No instance with principal_did ${req.targetPrincipalDid}`,
      );
      return;
    }

    // 3. Hub-side ACL (defense in depth). The caller runtime already
    //    passed the directory ACL at resolve time, but we re-check
    //    here against the row we're actually routing to. Public
    //    exposure short-circuits the ACL — matches `resolvePrincipalTarget`
    //    in `instances.ts`. The caller is presented as an Agent-kind
    //    principal carrying its DID.
    const owner = resolveOwnerSubject(target);
    if (owner === null) {
      // Ownerless row — treat as missing for ACL purposes.
      metrics.inc(CounterName.HubA2ATargetMissing);
      this.sendA2AErrorResponse(
        conn.socket,
        req.requestId,
        "target_not_found",
        `Target has no resolvable owner`,
      );
      return;
    }
    const callerAgent: Subject = { kind: "principal", id: req.callerPrincipalDid };
    if (
      target.exposure !== "public" &&
      !(await subjectCanAccess(owner, callerAgent))
    ) {
      metrics.inc(CounterName.HubA2AForbidden);
      this.fastify.log.warn(
        {
          callerRuntime: conn.runtimeId,
          callerPrincipalDid: req.callerPrincipalDid,
          targetOwner: owner,
          requestId: req.requestId,
        },
        "a2a forbidden by hub-side ACL",
      );
      this.sendA2AErrorResponse(
        conn.socket,
        req.requestId,
        "forbidden",
        `Caller ${req.callerPrincipalDid} not allowed to reach target`,
      );
      return;
    }

    // 4. Find target tunnel. If offline, send a structured response
    //    so the caller's a2a_send fails cleanly instead of hanging.
    const targetConn = this.getConnection(target.runtimeId);
    if (!targetConn) {
      metrics.inc(CounterName.HubA2ATargetOffline);
      this.fastify.log.warn(
        {
          callerRuntime: conn.runtimeId,
          targetRuntime: target.runtimeId,
          requestId: req.requestId,
        },
        "a2a target offline",
      );
      this.sendA2AErrorResponse(
        conn.socket,
        req.requestId,
        "target_offline",
        `Target runtime ${target.runtimeId} not connected`,
      );
      return;
    }

    // 5. Forward — relay verbatim, including `signature` and
    //    `message`. The target verifies end-to-end.
    metrics.inc(CounterName.HubA2AForwarded);
    this.sendMessage(targetConn.socket, req);

    // Register in-flight for response correlation. TTL timer cleans
    // up the entry if the target never replies.
    const timer = setTimeout(() => {
      const entry = this.a2aInFlight.get(req.requestId);
      if (!entry) return;
      this.a2aInFlight.delete(req.requestId);
      metrics.inc(CounterName.HubA2ATimeout);
      this.fastify.log.warn(
        {
          requestId: req.requestId,
          callerRuntime: entry.callerRuntimeId,
          targetRuntime: entry.targetRuntimeId,
        },
        "a2a in-flight TTL expired",
      );
      this.sendA2AErrorResponse(
        entry.callerSocket,
        req.requestId,
        "timeout",
        "Target did not respond within TTL",
      );
    }, this.a2aInFlightTtlMs);
    timer.unref?.();

    this.a2aInFlight.set(req.requestId, {
      callerRuntimeId: conn.runtimeId,
      callerSocket: conn.socket,
      targetRuntimeId: target.runtimeId,
      targetSocket: targetConn.socket,
      timer,
    });
  }

  private handleAgentToAgentResponse(
    _conn: RuntimeConnection,
    resp: Extract<TunnelMessage, { type: "principal_to_principal_response" }>,
  ): void {
    const entry = this.a2aInFlight.get(resp.requestId);
    if (!entry) {
      // Caller already timed out (or this is a duplicate). Drop.
      this.fastify.log.debug(
        { requestId: resp.requestId },
        "a2a response with no in-flight entry",
      );
      return;
    }
    clearTimeout(entry.timer);
    this.a2aInFlight.delete(resp.requestId);
    this.sendMessage(entry.callerSocket, resp);
  }

  /**
   * Sweep `a2aInFlight` for entries touching a runtime that just
   * disconnected. Symmetric: the *surviving* side gets an
   * `internal_error` synthesized response so it doesn't carry a
   * request whose peer is gone.
   *
   *   - caller disconnects → notify the target (`internal_error`).
   *     Without this, the target's eventual reply would be silently
   *     dropped at `handleAgentToAgentResponse` (no in-flight entry)
   *     and the target runtime would carry the request until its own
   *     a2a timeout.
   *
   *   - target disconnects → notify the caller. (This was the
   *     pre-existing single-side behavior; the caller-side
   *     `target_offline` synthesized response at forwarding time only
   *     fires for a never-connected target. A target that drops
   *     mid-flight is a separate failure mode.)
   */
  private cleanupA2AForRuntime(runtimeId: string): void {
    for (const [requestId, entry] of this.a2aInFlight) {
      if (
        entry.callerRuntimeId === runtimeId ||
        entry.targetRuntimeId === runtimeId
      ) {
        clearTimeout(entry.timer);
        this.a2aInFlight.delete(requestId);
        const survivorSocket =
          entry.callerRuntimeId === runtimeId
            ? entry.targetSocket // tell the target its caller vanished
            : entry.callerSocket; // tell the caller its peer vanished
        if (survivorSocket && survivorSocket.readyState === survivorSocket.OPEN) {
          this.sendA2AErrorResponse(
            survivorSocket,
            requestId,
            "internal_error",
            "Peer runtime disconnected mid-flight",
          );
        }
      }
    }
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

    // Issue #16: clean up any in-flight a2a requests that touched
    // this runtime (either as caller or as target). Survivors get an
    // `internal_error` synthesized response.
    this.cleanupA2AForRuntime(conn.runtimeId);

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
        agent: request.instanceId, // fallback agent identifier
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
          // If resolved without stream init, treat as immediate response
          if (!pending.receivedStreamInit) {
            try {
              sink.onChunk(String(result.body ?? ""));
              sink.onEnd();
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
        agent: request.principalName,
        payload: Array.from(encodeHttpRequestBody(request)),
      });

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

export { HEARTBEAT_INTERVAL_SECS, HEARTBEAT_TIMEOUT_MS };
