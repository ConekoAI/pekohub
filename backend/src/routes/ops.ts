import type { FastifyPluginAsync } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { metrics } from "../services/metrics.js";

/**
 * Operational endpoints: `/health` for uptime checks and Fly health
 * checks, `/metrics` for the counter snapshot.
 */
export interface OpsRoutesOptions {
  /** Bearer token for `/metrics`; without one the route doesn't exist. */
  metricsToken?: string;
  /** Resolves when the database answers. Tests replace it. */
  pingDatabase?: () => Promise<unknown>;
}

/**
 * How long `/health` waits for the database. Neon's first query after it
 * scales to zero takes about half a second, now and then a few seconds.
 */
export const HEALTH_DB_TIMEOUT_MS = 5000;

const VERSION = "0.1.0";

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function sameToken(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

const opsRoutes: FastifyPluginAsync<OpsRoutesOptions> = async (fastify, options) => {
  const pingDatabase = options.pingDatabase ?? (() => db.execute(sql`select 1`));

  // 200 when the API and its database answer, 503 otherwise. Unauthenticated,
  // says nothing beyond up or down, and stays under the global rate limit.
  fastify.get("/health", async (_request, reply) => {
    try {
      await withTimeout(pingDatabase(), HEALTH_DB_TIMEOUT_MS);
      return { status: "ok", version: VERSION, database: "ok" };
    } catch (err) {
      fastify.log.warn({ err }, "Health check: database unreachable");
      return reply
        .status(503)
        .send({ status: "error", version: VERSION, database: "unreachable" });
    }
  });

  // In-process counters (services/metrics.ts). They name runtimes' traffic
  // patterns, so only a caller holding METRICS_TOKEN reads them.
  const metricsToken = options.metricsToken;
  if (metricsToken) {
    fastify.get("/metrics", async (request, reply) => {
      const header = request.headers.authorization ?? "";
      const given = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
      if (!given || !sameToken(given, metricsToken)) {
        return reply.status(401).send({ error: "Unauthorized" });
      }
      return metrics.snapshot();
    });
  }
};

export default opsRoutes;
