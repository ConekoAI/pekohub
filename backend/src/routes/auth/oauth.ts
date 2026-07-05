import type { FastifyInstance } from "fastify";
import { GitHub, Google } from "arctic";
import { db } from "../../db/index.js";
import { users, refreshTokens } from "../../db/schema.js";
import { eq, and, isNull, gt } from "drizzle-orm";
import bcrypt from "bcryptjs";

/**
 * OAuth 2.0 login flow + refresh-token endpoints
 * GET /api/v1/auth/:provider/authorize
 * GET /api/v1/auth/:provider/callback
 * POST /api/v1/auth/refresh
 * GET /api/v1/auth/me
 * POST /api/v1/auth/logout
 *
 * Stateless refresh-token model: POST /auth/refresh exchanges a
 * refresh-token cookie for a new access token. No server-side
 * session store.
 */
export default async function oauthRoutes(fastify: FastifyInstance) {
  const github = fastify.config.GITHUB_CLIENT_ID
    ? new GitHub(
        fastify.config.GITHUB_CLIENT_ID,
        fastify.config.GITHUB_CLIENT_SECRET!,
        {
          redirectURI: `${fastify.config.REGISTRY_BASE_URL}/v1/auth/github/callback`,
        },
      )
    : null;

  const google = fastify.config.GOOGLE_CLIENT_ID
    ? new Google(
        fastify.config.GOOGLE_CLIENT_ID,
        fastify.config.GOOGLE_CLIENT_SECRET!,
        `${fastify.config.REGISTRY_BASE_URL}/v1/auth/google/callback`,
      )
    : null;

  // Initiate OAuth flow
  fastify.get("/:provider/authorize", async (request, reply) => {
    const { provider } = request.params as { provider: string };
    const state = crypto.randomUUID();

    let url: URL;
    if (provider === "github" && github) {
      url = await github.createAuthorizationURL(state, {
        scopes: ["read:user"],
      });
    } else if (provider === "google" && google) {
      const codeVerifier = crypto.randomUUID() + crypto.randomUUID();
      url = await google.createAuthorizationURL(state, codeVerifier, {
        scopes: ["openid", "email", "profile"],
      });
      reply.setCookie("oauth_code_verifier", codeVerifier, {
        path: "/",
        httpOnly: true,
        secure: fastify.config.NODE_ENV === "production",
        maxAge: 600, // 10 minutes
      });
    } else {
      return reply
        .status(400)
        .send({ error: "Unsupported or unconfigured provider" });
    }

    reply.setCookie("oauth_state", state, {
      path: "/",
      httpOnly: true,
      secure: fastify.config.NODE_ENV === "production",
      maxAge: 600, // 10 minutes
    });

    return reply.redirect(url.toString());
  });

  // OAuth callback
  fastify.get("/:provider/callback", async (request, reply) => {
    const { provider } = request.params as { provider: string };
    const { code, state } = request.query as { code: string; state: string };
    const cookieState = request.cookies.oauth_state;

    if (!code || !state || state !== cookieState) {
      return reply.status(400).send({ error: "Invalid OAuth state" });
    }

    let userInfo: {
      id: string;
      namespace: string;
      name: string;
      email?: string;
      avatar?: string;
    };

    if (provider === "github" && github) {
      const tokens = await github.validateAuthorizationCode(code);
      const response = await fetch("https://api.github.com/user", {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      });
      const data = (await response.json()) as {
        id: number;
        login: string;
        name?: string;
        email?: string;
        avatar_url?: string;
      };
      userInfo = {
        id: `github:${data.id}`,
        namespace: data.login,
        name: data.name ?? data.login,
        email: data.email,
        avatar: data.avatar_url,
      };
    } else if (provider === "google" && google) {
      const codeVerifier = request.cookies.oauth_code_verifier;
      if (!codeVerifier) {
        return reply.status(400).send({ error: "Missing code verifier" });
      }
      const tokens = await google.validateAuthorizationCode(code, codeVerifier);
      const response = await fetch(
        "https://openidconnect.googleapis.com/v1/userinfo",
        {
          headers: { Authorization: `Bearer ${tokens.accessToken}` },
        },
      );
      const data = (await response.json()) as {
        sub: string;
        name: string;
        email?: string;
        picture?: string;
      };
      userInfo = {
        id: `google:${data.sub}`,
        namespace: data.email?.split("@")[0] ?? data.sub,
        name: data.name,
        email: data.email,
        avatar: data.picture,
      };
    } else {
      return reply.status(400).send({ error: "Unsupported provider" });
    }

    // Upsert user
    let user = await db.query.users.findFirst({
      where: eq(users.externalId, userInfo.id),
    });

    if (!user) {
      const [inserted] = await db
        .insert(users)
        .values({
          externalId: userInfo.id,
          provider,
          namespace: userInfo.namespace,
          displayName: userInfo.name,
          email: userInfo.email,
          avatarUrl: userInfo.avatar,
        })
        .returning();
      user = inserted;
    }

    // Issue short-lived access JWT (15 minutes)
    const accessToken = await reply.jwtSign(
      { sub: String(user.id), namespace: user.namespace },
      { expiresIn: "15m" },
    );

    // Issue refresh token (30 days, HTTP-only cookie)
    const deviceInfo = request.headers["user-agent"] ?? undefined;
    const refreshToken = await fastify.issueRefreshToken(user.id, deviceInfo);

    reply.setCookie("pekohub_refresh", refreshToken, {
      path: "/",
      httpOnly: true,
      secure: fastify.config.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 30 * 24 * 60 * 60, // 30 days in seconds
    });

    // Clear legacy session cookie if present
    reply.clearCookie("pekohub_session", { path: "/" });

    // Redirect to frontend
    return reply.redirect(
      `${fastify.config.FRONTEND_URL ?? fastify.config.REGISTRY_BASE_URL}/auth/callback?token=${accessToken}`,
    );
  });

  // POST /api/v1/auth/refresh
  fastify.post("/refresh", async (request, reply) => {
    const refreshCookie = request.cookies.pekohub_refresh;
    if (!refreshCookie) {
      return reply.status(401).send({ error: "Missing refresh token" });
    }

    const validated = await fastify.validateRefreshToken(refreshCookie);
    if (!validated) {
      return reply
        .status(401)
        .send({ error: "Invalid or expired refresh token" });
    }

    // Rotate refresh token
    const deviceInfo = request.headers["user-agent"] ?? undefined;
    const newRefreshToken = await fastify.rotateRefreshToken(
      validated.id,
      validated.userId,
      deviceInfo,
    );

    reply.setCookie("pekohub_refresh", newRefreshToken, {
      path: "/",
      httpOnly: true,
      secure: fastify.config.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 30 * 24 * 60 * 60,
    });

    // Issue new access JWT
    const user = await db.query.users.findFirst({
      where: eq(users.id, validated.userId),
    });

    if (!user) {
      return reply.status(401).send({ error: "User not found" });
    }

    const accessToken = await reply.jwtSign(
      { sub: String(user.id), namespace: user.namespace },
      { expiresIn: "15m" },
    );

    return { token: accessToken };
  });

  // GET /api/v1/auth/me
  fastify.get("/me", async (request, reply) => {
    try {
      const user = await fastify.authenticate(request);
      return {
        id: user.id,
        namespace: user.namespace,
        displayName: user.displayName,
        email: user.email,
        avatarUrl: user.avatarUrl,
      };
    } catch {
      return reply.status(401).send({ error: "Unauthorized" });
    }
  });

  // POST /api/v1/auth/logout
  fastify.post("/logout", async (request, reply) => {
    const refreshCookie = request.cookies.pekohub_refresh;

    if (refreshCookie) {
      // Find and revoke the token in DB (best-effort)
      const validated = await fastify.validateRefreshToken(refreshCookie);
      if (validated) {
        await fastify.revokeRefreshToken(validated.id);
      }
    }

    reply.clearCookie("pekohub_refresh", { path: "/" });
    reply.clearCookie("pekohub_session", { path: "/" });
    return { success: true };
  });
}
