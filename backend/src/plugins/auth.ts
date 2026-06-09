import fp from "fastify-plugin";
import fastifyJwt from "@fastify/jwt";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { db } from "../db/index.js";
import { users, apiKeys, refreshTokens } from "../db/schema.js";
import { eq, and, isNull, gt, isNotNull, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { auditService } from "../services/audit.js";

export interface AuthenticatedUser {
  id: number;
  namespace: string;
  displayName: string | null;
  email: string | null;
  avatarUrl: string | null;
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    user: AuthenticatedUser;
  }
}

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest) => Promise<AuthenticatedUser>;
    issueRefreshToken: (userId: number, deviceInfo?: string) => Promise<string>;
    validateRefreshToken: (
      token: string,
    ) => Promise<{ id: string; userId: number } | null>;
    revokeRefreshToken: (id: string) => Promise<void>;
    revokeAllUserRefreshTokens: (userId: number) => Promise<void>;
    rotateRefreshToken: (
      oldId: string,
      userId: number,
      deviceInfo?: string,
    ) => Promise<string>;
  }
}

const REFRESH_TOKEN_BYTES = 64;
const REFRESH_TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function generateRefreshTokenValue(): string {
  const array = new Uint8Array(REFRESH_TOKEN_BYTES);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Prefix(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

async function authPlugin(fastify: FastifyInstance) {
  await fastify.register(fastifyJwt, {
    secret: fastify.config.JWT_SECRET,
    cookie: {
      cookieName: "pekohub_refresh",
      signed: false,
    },
  });

  fastify.decorate("authenticate", async (request: FastifyRequest) => {
    // Try Bearer token (API key or JWT)
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7);

      // Check if it's an API key (starts with a known prefix pattern)
      if (token.startsWith("ph_")) {
        const prefix = token.slice(0, 8);
        const keyRecord = await db.query.apiKeys.findFirst({
          where: eq(apiKeys.prefix, prefix),
        });

        if (!keyRecord) {
          throw new Error("Invalid API key");
        }

        // Verify hash
        const valid = await bcrypt.compare(token, keyRecord.hash);
        if (!valid) {
          throw new Error("Invalid API key");
        }

        // Update last used timestamp
        await db
          .update(apiKeys)
          .set({ lastUsedAt: new Date() })
          .where(eq(apiKeys.id, keyRecord.id));

        const user = await db.query.users.findFirst({
          where: eq(users.id, keyRecord.userId),
        });

        if (!user) {
          throw new Error("User not found");
        }

        return {
          id: user.id,
          namespace: user.namespace,
          displayName: user.displayName,
          email: user.email,
          avatarUrl: user.avatarUrl,
        };
      }

      // Otherwise treat as JWT access token
      const decoded = await request.jwtVerify<{
        sub: string;
        namespace: string;
      }>();
      const user = await db.query.users.findFirst({
        where: eq(users.id, Number(decoded.sub)),
      });

      if (!user) {
        throw new Error("User not found");
      }

      return {
        id: user.id,
        namespace: user.namespace,
        displayName: user.displayName,
        email: user.email,
        avatarUrl: user.avatarUrl,
      };
    }

    throw new Error("Missing or invalid authorization");
  });

  // ── Refresh token helpers ───────────────────────────────────────────────────

  fastify.decorate(
    "issueRefreshToken",
    async (userId: number, deviceInfo?: string) => {
      const plainToken = generateRefreshTokenValue();
      const tokenHash = await bcrypt.hash(plainToken, 10);
      const tokenPrefix = await sha256Prefix(plainToken);
      const id = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + REFRESH_TOKEN_LIFETIME_MS);

      await db.insert(refreshTokens).values({
        id,
        userId,
        tokenPrefix,
        tokenHash,
        deviceInfo: deviceInfo ?? null,
        expiresAt,
      });

      return plainToken;
    },
  );

  fastify.decorate("validateRefreshToken", async (token: string) => {
    const prefix = await sha256Prefix(token);
    const now = new Date();

    // Fast path: query only tokens matching the SHA-256 prefix
    // Check revoked tokens first (reuse / theft detection)
    const revokedCandidates = await db.query.refreshTokens.findMany({
      where: and(
        eq(refreshTokens.tokenPrefix, prefix),
        isNotNull(refreshTokens.revokedAt),
        gt(refreshTokens.expiresAt, now),
      ),
      orderBy: (rt, { desc }) => [desc(rt.createdAt)],
      limit: 5,
    });

    for (const candidate of revokedCandidates) {
      const match = await bcrypt.compare(token, candidate.tokenHash);
      if (match) {
        // Token reuse detected — revoke all tokens for this user atomically
        await db
          .update(refreshTokens)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(refreshTokens.userId, candidate.userId),
              isNull(refreshTokens.revokedAt),
            ),
          );

        await auditService.logSecurityEvent(
          "refresh_token_reuse",
          candidate.userId,
          `refresh_token:${candidate.id}`,
          { rotatedFrom: candidate.rotatedFrom },
        );
        return null;
      }
    }

    // Query active tokens matching the prefix
    const candidates = await db.query.refreshTokens.findMany({
      where: and(
        eq(refreshTokens.tokenPrefix, prefix),
        isNull(refreshTokens.revokedAt),
        gt(refreshTokens.expiresAt, now),
      ),
      orderBy: (rt, { desc }) => [desc(rt.createdAt)],
      limit: 5,
    });

    for (const candidate of candidates) {
      const match = await bcrypt.compare(token, candidate.tokenHash);
      if (match) {
        return { id: candidate.id, userId: candidate.userId };
      }
    }

    return null;
  });

  fastify.decorate("revokeRefreshToken", async (id: string) => {
    await db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(eq(refreshTokens.id, id));
  });

  fastify.decorate("revokeAllUserRefreshTokens", async (userId: number) => {
    await db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)),
      );
  });

  fastify.decorate(
    "rotateRefreshToken",
    async (oldId: string, userId: number, deviceInfo?: string) => {
      // Revoke old token
      await fastify.revokeRefreshToken(oldId);

      // Issue new token
      const plainToken = generateRefreshTokenValue();
      const tokenHash = await bcrypt.hash(plainToken, 10);
      const tokenPrefix = await sha256Prefix(plainToken);
      const newId = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + REFRESH_TOKEN_LIFETIME_MS);

      await db.insert(refreshTokens).values({
        id: newId,
        userId,
        tokenPrefix,
        tokenHash,
        deviceInfo: deviceInfo ?? null,
        expiresAt,
        rotatedFrom: oldId,
      });

      return plainToken;
    },
  );
}

export default fp(authPlugin);
