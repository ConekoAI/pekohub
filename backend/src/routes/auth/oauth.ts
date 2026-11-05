import type { FastifyInstance } from "fastify";
import { GitHub, Google } from "arctic";
import { db } from "../../db/index.js";
import { users, refreshTokens } from "../../db/schema.js";
import { eq, and, isNull, gt } from "drizzle-orm";
import bcrypt from "bcryptjs";
import {
  chooseHandle,
  findOrCreateUser,
  handleAvailability,
  handleLock,
  type ProviderProfile,
} from "../../services/accounts.js";
import { AccountSuspendedError } from "../../plugins/auth.js";

/**
 * OAuth 2.0 login flow + refresh-token endpoints
 * GET /api/v1/auth/:provider/authorize
 * GET /api/v1/auth/:provider/callback
 * POST /api/v1/auth/refresh
 * GET /api/v1/auth/me
 * GET /api/v1/auth/handle/:handle  (can I take this handle?)
 * PUT /api/v1/auth/handle          (keep or change my handle)
 * POST /api/v1/auth/logout
 *
 * Stateless refresh-token model: POST /auth/refresh exchanges a
 * refresh-token cookie for a new access token. No server-side
 * session store.
 */
const HANDLE_REFUSALS = {
  invalid: {
    status: 400,
    error:
      "2 to 39 lowercase letters, digits, - or _, starting and ending with a letter or digit",
  },
  reserved: { status: 400, error: "That handle is kept for PekoHub itself" },
  taken: { status: 409, error: "Someone already has that handle" },
  locked: {
    status: 409,
    error: "Your handle is fixed: something is published under it",
  },
} as const;

/** Whether the person confirmed their handle, and whether it can still change. */
async function handleState(userId: string, namespace: string) {
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { handleChosenAt: true, createdAt: true },
  });
  return {
    handleChosen: user?.handleChosenAt != null,
    handleLocked: (await handleLock(userId, namespace)) !== null,
    createdAt: user?.createdAt.toISOString(),
  };
}

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

    let profile: ProviderProfile;

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
      profile = {
        externalId: `github:${data.id}`,
        provider,
        suggestedHandle: data.login,
        displayName: data.name ?? data.login,
        email: data.email,
        avatarUrl: data.avatar_url,
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
      profile = {
        externalId: `google:${data.sub}`,
        provider,
        // The name, not the address: a handle is public.
        suggestedHandle: data.name || "user",
        displayName: data.name,
        email: data.email,
        avatarUrl: data.picture,
      };
    } else {
      return reply.status(400).send({ error: "Unsupported provider" });
    }

    // First sign-in makes the account, with a free, valid handle.
    const user = await findOrCreateUser(profile);
    if (user.suspendedAt) {
      return reply.redirect(
        `${fastify.config.FRONTEND_URL ?? fastify.config.REGISTRY_BASE_URL}/auth/callback?error=${encodeURIComponent("This account is suspended")}`,
      );
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

    // Redirect to the website. The token rides the fragment, which the
    // browser never sends to a server or in a Referer; the callback page
    // removes it from the address bar and history.
    return reply.redirect(
      `${fastify.config.FRONTEND_URL ?? fastify.config.REGISTRY_BASE_URL}/auth/callback#token=${encodeURIComponent(accessToken)}`,
    );
  });

  // POST /api/v1/auth/refresh
  fastify.post("/refresh", async (request, reply) => {
    const refreshCookie = request.cookies.pekohub_refresh;
    if (!refreshCookie) {
      return reply.status(401).send({ error: "Missing refresh token" });
    }

    const validated = await fastify.validateRefreshToken(refreshCookie);
    // A token issued to an OAuth client (desktop, CLI) is refreshed only
    // through `POST /oauth/token`, never as the website's cookie.
    if (!validated || validated.clientId !== null) {
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
    if (user.suspendedAt) {
      await fastify.revokeAllUserRefreshTokens(user.id);
      return reply.status(403).send({ error: "This account is suspended" });
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
        role: user.role,
        ...(await handleState(user.id, user.namespace)),
      };
    } catch (err) {
      if (err instanceof AccountSuspendedError) {
        return reply.status(403).send({ error: err.message });
      }
      return reply.status(401).send({ error: "Unauthorized" });
    }
  });

  // GET /api/v1/auth/handle/:handle — whether the signed-in person could
  // take this handle. Their own counts as available.
  fastify.get("/handle/:handle", async (request) => {
    const user = await fastify.authenticate(request);
    const { handle } = request.params as { handle: string };
    const wanted = handle.trim().replace(/^@/, "").toLowerCase();
    return { handle: wanted, ...(await handleAvailability(user.id, wanted)) };
  });

  // PUT /api/v1/auth/handle — keep the handle (confirms it) or change it
  // while nothing is published under it.
  fastify.put("/handle", async (request, reply) => {
    const user = await fastify.authenticate(request);
    const { handle } = (request.body ?? {}) as { handle?: unknown };
    if (typeof handle !== "string") {
      return reply.status(400).send({ code: "invalid", error: "Give a handle" });
    }
    const result = await chooseHandle(user.id, handle);
    if (!result.ok) {
      const { status, error } = HANDLE_REFUSALS[result.reason];
      return reply.status(status).send({ code: result.reason, error });
    }
    const chosen = result.user;
    // A fresh token, so the website's copy of the handle is the new one.
    const token = await reply.jwtSign(
      { sub: String(chosen.id), namespace: chosen.namespace },
      { expiresIn: "15m" },
    );
    return {
      namespace: chosen.namespace,
      token,
      ...(await handleState(chosen.id, chosen.namespace)),
    };
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
