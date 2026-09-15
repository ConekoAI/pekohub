/**
 * TunnelRouter — HTTP ↔ tunnel bridge for chat and streaming requests.
 */

import type { FastifyReply } from "fastify";
import type { TunnelManager } from "./tunnel-manager.js";
import type { HttpProxiedRequest, TunnelMessage } from "./tunnel-protocol.js";
import { subjectToString, type Subject } from "@pekohub/shared";
import type { QuotaStore } from "./quotas.js";
import { mintBridgeToken } from "./bridge-token.js";

/** Quota row shape pulled from `instances`. Kept as a narrow
 *  interface so the route layer can map Drizzle rows without
 *  importing the full schema into this file. */
export interface QuotaCaps {
  daily: number | null;
  weekly: number | null;
}

/** Headers we always write before the SSE body. Extracted so
 *  both `proxyChat` and `proxyStream` agree on the headers —
 *  the SPA's `EventSource` parse depends on `text/event-stream`
 *  plus `Cache-Control: no-cache` and `Connection: keep-alive`.
 *
 *  We also forward any `Set-Cookie` header that Fastify has
 *  accumulated via `reply.setCookie()` (PR-B1: the visitor cookie
 *  for anonymous public chat). Fastify's `reply.setCookie` queues
 *  the value into the reply's header store; once we call
 *  `reply.raw.writeHead` directly, Fastify's queued headers are
 *  bypassed, so we copy them over by hand. Without this, the
 *  visitor cookie would never reach the browser on first visit. */
function writeStreamHeaders(reply: FastifyReply): void {
  // Forward any Set-Cookie that the route queued via
  // `reply.raw.setHeader` (PR-B1: visitor cookie). Fastify's
  // @fastify/cookie stores queued cookies in a Symbol-keyed Map
  // and only flushes them in `onSend`, which never runs for an
  // SSE-hijacked response, so the route writes to `reply.raw`
  // directly and we forward it here. Without this, the visitor
  // cookie would never reach the browser on first visit.
  const setCookie = reply.raw.getHeader("Set-Cookie") as
    | string
    | string[]
    | undefined;
  const headers: Record<string, string | string[]> = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  };
  if (setCookie !== undefined) {
    headers["Set-Cookie"] = setCookie;
  }
  reply.raw.writeHead(200, headers);
}

/**
 * Build the bridge headers for a proxied request. Issue #11: the hub
 * now identifies callers by a `Principal`, not just a numeric user id.
 *
 * - User callers get the legacy `x-pekohub-user-id` header (preserves
 *   the pre-#11 runtime's caller-resolution path).
 * - Subject-kind callers (Principal only post-#82) get `x-pekohub-caller-principal`
 *   (the runtime-side reader is gated on peko-runtime#16). The
 *   legacy user-id header is omitted for non-User callers so the
 *   runtime's `resolve_bridge_caller` doesn't attribute an Agent
 *   request to a non-existent user.
 * - Anonymous public chat (PR-B1): when caller is null and a
 *   visitor cookie is present, fall back to `x-pekohub-user-id:
 *   <visitorId>`. The runtime's `Subject::from_bridge_user`
 *   projects the bare UUID to `Subject::User(<uuid>)`, which
 *   the chat-log store keys on (see
 *   `peko-runtime/peko-rs/chat-log/src/types.rs`) — so two
 *   visitors land in two chat-log shards, and a returning
 *   visitor on the same cookie resumes its own thread.
 */
interface BridgeConfig {
  /** Hub public origin — becomes the bridge token's `iss`. */
  issuer: string;
  jwtSecret: string;
}

/**
 * ADR-057: the caller's identity reaches the runtime ONLY as a signed
 * EdDSA bridge token (`Authorization: Bearer <jwt>`, aud = the target
 * runtime DID, 60s expiry). The retired `x-pekohub-user-id` /
 * `x-pekohub-caller-principal` headers were unverified hub-asserted
 * claims and are no longer sent.
 */
function bridgeHeadersFor(
  base: Record<string, string>,
  caller: Subject | null,
  visitorId: string | null,
  runtimeId: string,
  bridge: BridgeConfig,
): Record<string, string> {
  const sub =
    caller === null
      ? (visitorId ?? "anonymous")
      : caller.kind === "user"
        ? caller.id
        : subjectToString(caller);
  const token = mintBridgeToken(bridge.jwtSecret, {
    sub,
    aud: runtimeId,
    iss: bridge.issuer,
  });
  return { ...base, authorization: `Bearer ${token}` };
}

export class TunnelRouter {
  constructor(
    private tunnelManager: TunnelManager,
    private quotaStore: QuotaStore,
    private bridge: BridgeConfig,
  ) {}

  /**
   * Check the per-instance quota (PR-B3) before opening an SSE
   * stream. When the cap is reached, write a single
   * `event: error` SSE frame with `code: "quota_exceeded"` and
   * end the response so the SPA can render a dedicated UI. Returns
   * `true` if quota allowed the message, `false` if rejected (in
   * which case the response is already terminated with a 429).
   *
   * Caller MUST NOT have written headers yet — we set the status
   * code here so the quota-exceeded path produces a clean 429
   * instead of a 200-then-error race.
   */
  private async checkQuotaOrReject(
    instanceId: string,
    daily: number | null,
    weekly: number | null,
    reply: FastifyReply,
  ): Promise<boolean> {
    const result = await this.quotaStore.consume(instanceId, daily, weekly);
    if (result.allowed) return true;
    reply.raw.writeHead(429, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    });
    reply.raw.write(
      `event: error\ndata: ${JSON.stringify({
        code: "quota_exceeded",
        reason: result.reason,
        message:
          result.reason === "daily"
            ? "This principal has reached its daily message limit. Please try again tomorrow."
            : "This principal has reached its weekly message limit. Please try again next week.",
      })}\n\n`,
    );
    reply.raw.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    reply.raw.end();
    return false;
  }

  async proxyChat(
    runtimeId: string,
    instanceId: string,
    principalName: string,
    body: unknown,
    headers: Record<string, string>,
    reply: FastifyReply,
    caller: Subject | null = null,
    visitorId: string | null = null,
    quota: QuotaCaps = { daily: null, weekly: null },
  ): Promise<void> {
    // Fail fast if runtime is not connected
    if (!this.tunnelManager.isRuntimeConnected(runtimeId)) {
      return reply.status(502).send({ error: "Instance unreachable" });
    }

    const mergedHeaders = bridgeHeadersFor(headers, caller, visitorId, runtimeId, this.bridge);

    const request: HttpProxiedRequest = {
      requestId: crypto.randomUUID(),
      instanceId,
      principalName,
      method: "chat",
      body,
      headers: mergedHeaders,
    };

    const quotaAllowed = await this.checkQuotaOrReject(
      instanceId,
      quota.daily,
      quota.weekly,
      reply,
    );
    if (!quotaAllowed) return;

    writeStreamHeaders(reply);

    const sink = {
      onChunk: (chunk: string) => {
        reply.raw.write(`data: ${JSON.stringify({ chunk, done: false })}\n\n`);
      },
      onIteration: (iteration: number) => {
        // PR-B2: per-iteration boundary for web-chat iteration bubbles.
        // Emitted as a typed SSE event (not a `data:` envelope) so the
        // SPA can route it through `addEventListener("iteration", ...)`
        // alongside `data:` chunk/done messages.
        reply.raw.write(
          `event: iteration\ndata: ${JSON.stringify({ iteration })}\n\n`,
        );
      },
      onEnd: () => {
        reply.raw.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        reply.raw.end();
      },
      onError: (err: Error) => {
        reply.raw.write(
          `event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`,
        );
        reply.raw.end();
      },
    };

    try {
      await this.tunnelManager.startStream(runtimeId, request, sink);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Stream failed";
      sink.onError(new Error(message));
    }
  }

  async proxyStream(
    runtimeId: string,
    instanceId: string,
    principalName: string,
    body: unknown,
    headers: Record<string, string>,
    reply: FastifyReply,
    caller: Subject | null = null,
    visitorId: string | null = null,
    quota: QuotaCaps = { daily: null, weekly: null },
  ): Promise<void> {
    // Fail fast if runtime is not connected
    if (!this.tunnelManager.isRuntimeConnected(runtimeId)) {
      return reply.status(502).send({ error: "Instance unreachable" });
    }

    const mergedHeaders = bridgeHeadersFor(headers, caller, visitorId, runtimeId, this.bridge);

    const request: HttpProxiedRequest = {
      requestId: crypto.randomUUID(),
      instanceId,
      principalName,
      method: "stream",
      body,
      headers: mergedHeaders,
    };

    const quotaAllowed = await this.checkQuotaOrReject(
      instanceId,
      quota.daily,
      quota.weekly,
      reply,
    );
    if (!quotaAllowed) return;

    writeStreamHeaders(reply);

    const sink = {
      onChunk: (chunk: string) => {
        reply.raw.write(`data: ${JSON.stringify({ chunk, done: false })}\n\n`);
      },
      onIteration: (iteration: number) => {
        reply.raw.write(
          `event: iteration\ndata: ${JSON.stringify({ iteration })}\n\n`,
        );
      },
      onEnd: () => {
        reply.raw.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        reply.raw.end();
      },
      onError: (err: Error) => {
        reply.raw.write(
          `event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`,
        );
        reply.raw.end();
      },
    };

    try {
      await this.tunnelManager.startStream(runtimeId, request, sink);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Stream failed";
      sink.onError(new Error(message));
    }
  }

  sendControl(
    runtimeId: string,
    message: Extract<TunnelMessage, { type: "exposure_update" | "status_update" }>,
  ): void {
    // Fire-and-forget: control messages are best-effort. The runtime will
    // re-announce the instance to confirm the change.
    this.tunnelManager.broadcastControl(runtimeId, message).catch(() => {
      // Swallow errors — exposure/status update PATCH should not 500 due to tunnel
      // side-effects. Logging is handled inside broadcastControl.
    });
  }
}
