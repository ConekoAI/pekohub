/**
 * Per-instance message-quota plugin (PR-B3).
 *
 * Decorates `fastify.quotaStore` with a `QuotaStore` implementation
 * picked at boot:
 *
 *   - Redis (`RedisQuotaStore`) when `REDIS_URL` is set AND a connection
 *     succeeds. Atomic `INCR + EXPIRE` on
 *     `pekohub:quota:<instanceId>:d:<YYYY-MM-DD>` and
 *     `:w:<YYYY-Www>`.
 *   - In-memory (`InMemoryQuotaStore`) otherwise (dev / single-process /
 *     no-Redis prod). Counters lost on hub restart.
 *
 * The in-memory fallback is intentional: quotas are an *abuse* cap, not
 * a billing primitive. A botnet that can wait through a hub restart has
 * other problems. The Redis variant is the prod upgrade path.
 *
 * The plugin also passes the store to `TunnelRouter` so the chat proxy
 * can call `consume()` before opening an SSE stream.
 */

import fp from "fastify-plugin";
import { createClient, type RedisClientType } from "redis";
import type { FastifyInstance } from "fastify";
import {
  InMemoryQuotaStore,
  RedisQuotaStore,
  type QuotaStore,
} from "../services/quotas.js";

declare module "fastify" {
  interface FastifyInstance {
    quotaStore: QuotaStore;
  }
}

export default fp(
  async (fastify: FastifyInstance) => {
    let store: QuotaStore;

    if (process.env.REDIS_URL) {
      const client: RedisClientType = createClient({
        url: process.env.REDIS_URL,
      });
      client.on("error", (err) => {
        // Don't crash the hub if Redis flaps — log and let the
        // store surface errors per-call. The proxy path handles
        // failures via Fastify's error hook.
        fastify.log.warn({ err }, "Redis quota-store client error");
      });
      try {
        await client.connect();
        store = new RedisQuotaStore(client);
        fastify.log.info(
          "QuotaStore: Redis-backed (REDIS_URL set, connection established)",
        );
      } catch (err) {
        fastify.log.warn(
          { err },
          "QuotaStore: Redis connection failed, falling back to in-memory",
        );
        store = new InMemoryQuotaStore();
      }
    } else {
      store = new InMemoryQuotaStore();
      fastify.log.info(
        "QuotaStore: in-memory (set REDIS_URL to persist counters across restarts)",
      );
    }

    fastify.decorate("quotaStore", store);

    // Hand the store to the TunnelRouter if it has already been
    // constructed (it has, by `tunnelPlugin`). This is a soft
    // overwrite of the constructor default rather than a re-plumb —
    // TunnelRouter takes the store by reference, not by copy.
    if (fastify.tunnelRouter) {
      (fastify.tunnelRouter as unknown as { quotaStore: QuotaStore }).quotaStore = store;
    }

    fastify.addHook("onClose", async () => {
      if (store instanceof RedisQuotaStore) {
        try {
          await (
            store as unknown as { redis: RedisClientType }
          ).redis.quit();
        } catch {
          // best-effort
        }
      }
    });
  },
  {
    // Must run AFTER tunnelPlugin so the TunnelRouter has been
    // constructed and we can patch its quotaStore reference.
    dependencies: ["tunnel"],
  },
);