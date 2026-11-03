import fp from "fastify-plugin";
import fastifyJwt from "@fastify/jwt";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { db } from "../db/index.js";
import { users, apiKeys, refreshTokens, USER_ROLES, type UserRole } from "../db/schema.js";
import { eq, and, isNull, gt, isNotNull, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { auditService } from "../services/audit.js";

export interface AuthenticatedUser {
  // Post-H3: user id is a UUID string (was number). The runtime
  // already emits this as a string (JWT `sub`, `x-pekohub-user-id`
  // header), so the integer round-trip was a coercion hazard.
  id: string;
  namespace: string;
  displayName: string | null;
  email: string | null;
  avatarUrl: string | null;
  role: UserRole;
}

/** A suspended account's credentials are refused everywhere. */
export class AccountSuspendedError extends Error {
  readonly statusCode = 403;
  constructor() {
    super("This account is suspended");
  }
}

/** Thrown by `requireRole`; carries the status the error handler sends. */
export class AuthorizationError extends Error {
  constructor(
    readonly statusCode: 401 | 403,
    message: string,
  ) {
    super(message);
  }
}

/** Whether `role` can do what `required` can (roles are ordered). */
export function hasRole(role: UserRole, required: UserRole): boolean {
  return USER_ROLES.indexOf(role) >= USER_ROLES.indexOf(required);
}

function authenticatedUser(user: typeof users.$inferSelect): AuthenticatedUser {
  if (user.suspendedAt) throw new AccountSuspendedError();
  return {
    id: user.id,
    namespace: user.namespace,
    displayName: user.displayName,
    email: user.email,
    avatarUrl: user.avatarUrl,
    role: user.role,
  };
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    user: AuthenticatedUser;
  }
}

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest) => Promise<AuthenticatedUser>;
    /**
     * The signed-in user, if their role is at least `role`; otherwise
     * throws an `AuthorizationError` (401 signed out, 403 not staff).
     */
    requireRole: (request: FastifyRequest, role: UserRole) => Promise<AuthenticatedUser>;
    // Post-H3: userId is a UUID string (was number).
    issueRefreshToken: (
      userId: string,
      deviceInfo?: string,
      clientId?: string,
    ) => Promise<string>;
    validateRefreshToken: (
      token: string,
    ) => Promise<{ id: string; userId: string; clientId: string | null } | null>;
    revokeRefreshToken: (id: string) => Promise<void>;
    revokeAllUserRefreshTokens: (userId: string) => Promise<void>;
    rotateRefreshToken: (
      oldId: string,
      userId: string,
      deviceInfo?: string,
      clientId?: string | null,
    ) => Promise<string>;
  }
}

const REFRESH_TOKEN_BYTES = 64;
const REFRESH_TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
/**
 * A token rotated this recently still refreshes, as long as the token that
 * replaced it is live. Two refreshes racing (two website tabs, two desktop
 * calls) or a response lost on the way back present the old token again;
 * that is not theft, and treating it as theft signs the person out of
 * every app at once.
 */
export const REFRESH_REUSE_GRACE_MS = 30_000;

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
      if (token.startsWith("pkr_")) {
        // The full prefix is `pkr_` (4 chars) + 6 hex chars = 10 chars.
        // Match the api_keys.prefix column exactly so the by-prefix lookup
        // hits a single row.
        const prefix = token.slice(0, 10);
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

        return authenticatedUser(user);
      }

      // Otherwise treat as JWT access token. Post-H3 the `sub` claim
      // is a UUID string (was integer-Stringified); convert before
      // comparing to users.id.
      const decoded = await request.jwtVerify<{
        sub: string;
        namespace: string;
        typ?: string;
      }>();
      // Other signed tokens (an OAuth authorize request) share the
      // secret; only access tokens carry no `typ`.
      if (decoded.typ !== undefined || typeof decoded.sub !== "string") {
        throw new Error("Not an access token");
      }
      const user = await db.query.users.findFirst({
        where: eq(users.id, decoded.sub),
      });

      if (!user) {
        throw new Error("User not found");
      }

      return authenticatedUser(user);
    }

    throw new Error("Missing or invalid authorization");
  });

  fastify.decorate("requireRole", async (request: FastifyRequest, role: UserRole) => {
    let user: AuthenticatedUser;
    try {
      user = await fastify.authenticate(request);
    } catch (err) {
      if (err instanceof AccountSuspendedError) throw err;
      throw new AuthorizationError(401, "Sign in first");
    }
    if (!hasRole(user.role, role)) {
      throw new AuthorizationError(403, "Forbidden");
    }
    return user;
  });

  // ── Refresh token helpers ───────────────────────────────────────────────────

  fastify.decorate(
    "issueRefreshToken",
    async (userId: string, deviceInfo?: string, clientId?: string) => {
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
        clientId: clientId ?? null,
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
        if (
          candidate.revokedAt!.getTime() > now.getTime() - REFRESH_REUSE_GRACE_MS &&
          (await db.query.refreshTokens.findFirst({
            where: and(
              eq(refreshTokens.rotatedFrom, candidate.id),
              isNull(refreshTokens.revokedAt),
              gt(refreshTokens.expiresAt, now),
            ),
          }))
        ) {
          return {
            id: candidate.id,
            userId: candidate.userId,
            clientId: candidate.clientId ?? null,
          };
        }
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
        return {
          id: candidate.id,
          userId: candidate.userId,
          clientId: candidate.clientId ?? null,
        };
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

  fastify.decorate("revokeAllUserRefreshTokens", async (userId: string) => {
    await db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)),
      );
  });

  fastify.decorate(
    "rotateRefreshToken",
    async (
      oldId: string,
      userId: string,
      deviceInfo?: string,
      clientId?: string | null,
    ) => {
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
        clientId: clientId ?? null,
      });

      return plainToken;
    },
  );
}

export default fp(authPlugin);
