/**
 * TunnelRouter — HTTP ↔ tunnel bridge for chat and streaming requests.
 */

import type { FastifyReply } from 'fastify';
import type { TunnelManager } from './tunnel-manager.js';
import type { HttpProxiedRequest, TunnelMessage } from './tunnel-protocol.js';

export class TunnelRouter {
  constructor(private tunnelManager: TunnelManager) {}

  async proxyChat(
    runtimeId: string,
    instanceId: string,
    body: unknown,
    headers: Record<string, string>,
    reply: FastifyReply
  ): Promise<void> {
    const request: HttpProxiedRequest = {
      requestId: crypto.randomUUID(),
      instanceId,
      method: 'chat',
      body,
      headers,
    };

    const response = await this.tunnelManager.sendProxiedRequest(runtimeId, request);
    return reply.status(response.status).send(response.body);
  }

  async proxyStream(
    runtimeId: string,
    instanceId: string,
    body: unknown,
    headers: Record<string, string>,
    reply: FastifyReply
  ): Promise<void> {
    const request: HttpProxiedRequest = {
      requestId: crypto.randomUUID(),
      instanceId,
      method: 'stream',
      body,
      headers,
    };

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
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
        reply.raw.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`);
        reply.raw.end();
      },
    };

    try {
      await this.tunnelManager.startStream(runtimeId, request, sink);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Stream failed';
      sink.onError(new Error(message));
    }
  }

  sendControl(
    runtimeId: string,
    message: Extract<TunnelMessage, { type: 'exposure_update' }>
  ): void {
    // Fire-and-forget: control messages are best-effort. The runtime will
    // re-announce the instance to confirm the change.
    this.tunnelManager.broadcastControl(runtimeId, message).catch(() => {
      // Swallow errors — exposure update PATCH should not 500 due to tunnel
      // side-effects. Logging is handled inside broadcastControl.
    });
  }
}
