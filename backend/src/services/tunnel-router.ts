/**
 * TunnelRouter — HTTP ↔ tunnel bridge for chat and streaming requests.
 */

import type { FastifyReply } from "fastify";
import type { TunnelManager } from "./tunnel-manager.js";
import type { HttpProxiedRequest, TunnelMessage } from "./tunnel-protocol.js";
import { principalToString, type Principal } from "@pekohub/shared";

/**
 * Build the bridge headers for a proxied request. Issue #11: the hub
 * now identifies callers by a `Principal`, not just a numeric user id.
 *
 * - User callers get the legacy `x-pekohub-user-id` header (preserves
 *   the pre-#11 runtime's caller-resolution path).
 * - Agent / Team / Public callers get `x-pekohub-caller-principal`
 *   (the runtime-side reader is gated on peko-runtime#16). The
 *   legacy user-id header is omitted for non-User callers so the
 *   runtime's `resolve_bridge_caller` doesn't attribute an Agent
 *   request to a non-existent user.
 */
function bridgeHeadersFor(
  base: Record<string, string>,
  caller: Principal | null,
): Record<string, string> {
  if (caller === null) return base;
  if (caller.kind === "user") {
    return { ...base, "x-pekohub-user-id": caller.id };
  }
  return { ...base, "x-pekohub-caller-principal": principalToString(caller) };
}

export class TunnelRouter {
  constructor(private tunnelManager: TunnelManager) {}

  async proxyChat(
    runtimeId: string,
    instanceId: string,
    agentName: string,
    body: unknown,
    headers: Record<string, string>,
    reply: FastifyReply,
    caller: Principal | null = null,
  ): Promise<void> {
    // Fail fast if runtime is not connected
    if (!this.tunnelManager.isRuntimeConnected(runtimeId)) {
      return reply.status(502).send({ error: "Instance unreachable" });
    }

    const mergedHeaders = bridgeHeadersFor(headers, caller);

    const request: HttpProxiedRequest = {
      requestId: crypto.randomUUID(),
      instanceId,
      agentName,
      method: "chat",
      body,
      headers: mergedHeaders,
    };

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const sink = {
      onChunk: (chunk: string) => {
        reply.raw.write(`data: ${JSON.stringify({ chunk, done: false })}\n\n`);
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
    agentName: string,
    body: unknown,
    headers: Record<string, string>,
    reply: FastifyReply,
    caller: Principal | null = null,
  ): Promise<void> {
    // Fail fast if runtime is not connected
    if (!this.tunnelManager.isRuntimeConnected(runtimeId)) {
      return reply.status(502).send({ error: "Instance unreachable" });
    }

    const mergedHeaders = bridgeHeadersFor(headers, caller);

    const request: HttpProxiedRequest = {
      requestId: crypto.randomUUID(),
      instanceId,
      agentName,
      method: "stream",
      body,
      headers: mergedHeaders,
    };

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const sink = {
      onChunk: (chunk: string) => {
        reply.raw.write(`data: ${JSON.stringify({ chunk, done: false })}\n\n`);
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
