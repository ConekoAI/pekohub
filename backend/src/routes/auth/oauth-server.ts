import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  oauthAuthorizationCodes,
  oauthDeviceCodes,
  users,
} from "../../db/schema.js";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  AUTHORIZATION_CODE_TTL_MS,
  AUTHORIZE_REQUEST_TTL,
  DEVICE_CODE_GRANT,
  DEVICE_CODE_TTL_SECONDS,
  DEVICE_POLL_INTERVAL_SECONDS,
  findClient,
  formatUserCode,
  generateUserCode,
  isAllowedRedirectUri,
  isValidCodeChallenge,
  normalizeScope,
  normalizeUserCode,
  randomSecret,
  sha256Hex,
  verifyPkce,
  withQuery,
  type OAuthClient,
} from "../../services/oauth.js";

/**
 * OAuth 2.0 authorization server for Peko desktop and the Peko CLI.
 *
 * Protocol endpoints (unprefixed, on the API origin):
 *   GET  /oauth/authorize    → consent page on the website
 *   POST /oauth/token        → authorization_code (PKCE) | refresh_token | device_code
 *   POST /oauth/device/code  → start a device authorization (RFC 8628)
 *   POST /oauth/revoke       → revoke a refresh token (RFC 7009)
 *
 * Consent endpoints the website calls for a signed-in user:
 *   GET  /v1/oauth/authorize/describe?request=…
 *   POST /v1/oauth/authorize/decision   { request, approve }
 *   GET  /v1/oauth/device/describe?user_code=…
 *   POST /v1/oauth/device/decision      { user_code, approve }
 *
 * An authorize request travels to the consent page as a short-lived
 * signed token (`typ: "oauth_authorize"`), so the hub keeps no state
 * until the user approves.
 */

interface AuthorizeRequestClaims {
  typ: "oauth_authorize";
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  state?: string;
  scope?: string;
}

function webOrigin(fastify: FastifyInstance): string {
  return (fastify.config.FRONTEND_URL ?? fastify.config.REGISTRY_BASE_URL).replace(/\/+$/, "");
}

/** RFC 6749 §5.2 error response; token responses are never cached. */
function oauthError(reply: FastifyReply, status: number, error: string, description?: string) {
  return reply
    .status(status)
    .header("Cache-Control", "no-store")
    .header("Pragma", "no-cache")
    .send({ error, ...(description ? { error_description: description } : {}) });
}

function field(body: unknown, name: string): string | undefined {
  const value = (body as Record<string, unknown> | undefined)?.[name];
  return typeof value === "string" ? value : undefined;
}

async function issueTokens(
  fastify: FastifyInstance,
  reply: FastifyReply,
  request: FastifyRequest,
  userId: string,
  client: OAuthClient,
  scope: string | null,
  rotateFrom?: string,
) {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) return oauthError(reply, 400, "invalid_grant", "The account no longer exists");

  const accessToken = fastify.jwt.sign(
    { sub: user.id, namespace: user.namespace, client_id: client.id },
    { expiresIn: `${ACCESS_TOKEN_TTL_SECONDS}s` },
  );
  const deviceInfo = request.headers["user-agent"] ?? undefined;
  const refreshToken = rotateFrom
    ? await fastify.rotateRefreshToken(rotateFrom, user.id, deviceInfo, client.id)
    : await fastify.issueRefreshToken(user.id, deviceInfo, client.id);

  return reply
    .header("Cache-Control", "no-store")
    .header("Pragma", "no-cache")
    .send({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      ...(scope ? { scope } : {}),
    });
}

export default async function oauthServerRoutes(fastify: FastifyInstance) {
  // ── Authorization endpoint ────────────────────────────────────────────────
  fastify.get("/oauth/authorize", async (request, reply) => {
    const q = request.query as Record<string, string | undefined>;
    const consentPage = `${webOrigin(fastify)}/authorize`;

    // Until the client and redirect URI check out, errors go to our own
    // page — never to an unvalidated redirect target.
    const client = findClient(q.client_id);
    if (!client || !client.grants.includes("authorization_code")) {
      return reply.redirect(withQuery(consentPage, { error: "invalid_client" }));
    }
    if (!isAllowedRedirectUri(client, q.redirect_uri)) {
      return reply.redirect(withQuery(consentPage, { error: "invalid_redirect_uri" }));
    }
    const redirectUri = q.redirect_uri!;

    if (q.response_type !== "code") {
      return reply.redirect(
        withQuery(redirectUri, { error: "unsupported_response_type", state: q.state }),
      );
    }
    if (q.code_challenge_method !== "S256" || !isValidCodeChallenge(q.code_challenge)) {
      return reply.redirect(
        withQuery(redirectUri, {
          error: "invalid_request",
          error_description: "PKCE with code_challenge_method=S256 is required",
          state: q.state,
        }),
      );
    }

    const claims: AuthorizeRequestClaims = {
      typ: "oauth_authorize",
      client_id: client.id,
      redirect_uri: redirectUri,
      code_challenge: q.code_challenge,
      ...(q.state ? { state: q.state } : {}),
      ...(normalizeScope(q.scope) ? { scope: normalizeScope(q.scope)! } : {}),
    };
    const requestToken = fastify.jwt.sign(claims, { expiresIn: AUTHORIZE_REQUEST_TTL });
    return reply.redirect(withQuery(consentPage, { request: requestToken }));
  });

  function readAuthorizeRequest(token: unknown): AuthorizeRequestClaims | null {
    if (typeof token !== "string") return null;
    try {
      const claims = fastify.jwt.verify<AuthorizeRequestClaims>(token);
      return claims.typ === "oauth_authorize" && findClient(claims.client_id) ? claims : null;
    } catch {
      return null;
    }
  }

  fastify.get("/v1/oauth/authorize/describe", async (request, reply) => {
    const claims = readAuthorizeRequest((request.query as { request?: string }).request);
    if (!claims) {
      return reply.status(400).send({ error: "This sign-in request expired. Start again from the app." });
    }
    const client = findClient(claims.client_id)!;
    return {
      client: { id: client.id, name: client.name },
      scope: claims.scope ?? null,
      redirectUri: claims.redirect_uri,
    };
  });

  fastify.post("/v1/oauth/authorize/decision", async (request, reply) => {
    let user;
    try {
      user = await fastify.authenticate(request);
    } catch {
      return reply.status(401).send({ error: "Sign in first" });
    }
    const claims = readAuthorizeRequest(field(request.body, "request"));
    if (!claims) {
      return reply.status(400).send({ error: "This sign-in request expired. Start again from the app." });
    }
    const approve = (request.body as { approve?: unknown } | undefined)?.approve === true;
    if (!approve) {
      return {
        redirectTo: withQuery(claims.redirect_uri, { error: "access_denied", state: claims.state }),
      };
    }

    const code = randomSecret();
    await db.insert(oauthAuthorizationCodes).values({
      codeHash: await sha256Hex(code),
      userId: user.id,
      clientId: claims.client_id,
      redirectUri: claims.redirect_uri,
      codeChallenge: claims.code_challenge,
      scope: claims.scope ?? null,
      expiresAt: new Date(Date.now() + AUTHORIZATION_CODE_TTL_MS),
    });
    return { redirectTo: withQuery(claims.redirect_uri, { code, state: claims.state }) };
  });

  // ── Device authorization (RFC 8628) ───────────────────────────────────────
  fastify.post("/oauth/device/code", async (request, reply) => {
    const client = findClient(field(request.body, "client_id"));
    if (!client || !client.grants.includes(DEVICE_CODE_GRANT)) {
      return oauthError(reply, 401, "invalid_client");
    }
    const deviceCode = randomSecret();
    const scope = normalizeScope(field(request.body, "scope"));

    // A user-code collision with another live code is vanishingly rare;
    // draw a fresh code and try again.
    const deviceCodeHash = await sha256Hex(deviceCode);
    let userCode = generateUserCode();
    for (let attempt = 1; ; attempt++) {
      try {
        await db.insert(oauthDeviceCodes).values({
          deviceCodeHash,
          userCode,
          clientId: client.id,
          scope,
          expiresAt: new Date(Date.now() + DEVICE_CODE_TTL_SECONDS * 1000),
        });
        break;
      } catch (error) {
        if (attempt >= 3) throw error;
        userCode = generateUserCode();
      }
    }

    const verificationUri = `${webOrigin(fastify)}/device`;
    return reply.header("Cache-Control", "no-store").send({
      device_code: deviceCode,
      user_code: formatUserCode(userCode),
      verification_uri: verificationUri,
      verification_uri_complete: withQuery(verificationUri, { code: formatUserCode(userCode) }),
      expires_in: DEVICE_CODE_TTL_SECONDS,
      interval: DEVICE_POLL_INTERVAL_SECONDS,
    });
  });

  async function liveDeviceCode(userCodeInput: unknown) {
    const userCode = normalizeUserCode(userCodeInput);
    if (!userCode) return null;
    const row = await db.query.oauthDeviceCodes.findFirst({
      where: eq(oauthDeviceCodes.userCode, userCode),
    });
    if (!row || row.status !== "pending" || row.expiresAt.getTime() <= Date.now()) return null;
    return row;
  }

  fastify.get("/v1/oauth/device/describe", async (request, reply) => {
    const row = await liveDeviceCode((request.query as { user_code?: string }).user_code);
    if (!row) {
      return reply.status(404).send({ error: "That code is not valid or has expired. Check the code in your terminal." });
    }
    const client = findClient(row.clientId)!;
    return {
      client: { id: client.id, name: client.name },
      scope: row.scope,
      userCode: formatUserCode(row.userCode),
    };
  });

  fastify.post("/v1/oauth/device/decision", async (request, reply) => {
    let user;
    try {
      user = await fastify.authenticate(request);
    } catch {
      return reply.status(401).send({ error: "Sign in first" });
    }
    const row = await liveDeviceCode(field(request.body, "user_code"));
    if (!row) {
      return reply.status(404).send({ error: "That code is not valid or has expired. Check the code in your terminal." });
    }
    const approve = (request.body as { approve?: unknown } | undefined)?.approve === true;
    const status = approve ? "approved" : "denied";
    await db
      .update(oauthDeviceCodes)
      .set({ status, userId: approve ? user.id : null })
      .where(
        and(
          eq(oauthDeviceCodes.deviceCodeHash, row.deviceCodeHash),
          eq(oauthDeviceCodes.status, "pending"),
        ),
      );
    return { status };
  });

  // ── Token endpoint ────────────────────────────────────────────────────────
  fastify.post("/oauth/token", async (request, reply) => {
    const body = request.body;
    const grantType = field(body, "grant_type");
    const client = findClient(field(body, "client_id"));
    if (!client) return oauthError(reply, 401, "invalid_client");
    if (!grantType) return oauthError(reply, 400, "invalid_request", "grant_type is required");
    if (!(client.grants as string[]).includes(grantType)) {
      return oauthError(reply, 400, "unauthorized_client");
    }

    if (grantType === "authorization_code") {
      const code = field(body, "code");
      if (!code) return oauthError(reply, 400, "invalid_request", "code is required");
      // Redeem atomically: a code works once.
      const [row] = await db
        .update(oauthAuthorizationCodes)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(oauthAuthorizationCodes.codeHash, await sha256Hex(code)),
            isNull(oauthAuthorizationCodes.usedAt),
          ),
        )
        .returning();
      if (
        !row ||
        row.expiresAt.getTime() <= Date.now() ||
        row.clientId !== client.id ||
        row.redirectUri !== field(body, "redirect_uri")
      ) {
        return oauthError(reply, 400, "invalid_grant");
      }
      if (!(await verifyPkce(field(body, "code_verifier"), row.codeChallenge))) {
        return oauthError(reply, 400, "invalid_grant", "code_verifier does not match");
      }
      return issueTokens(fastify, reply, request, row.userId, client, row.scope);
    }

    if (grantType === "refresh_token") {
      const token = field(body, "refresh_token");
      const validated = token ? await fastify.validateRefreshToken(token) : null;
      if (!validated || validated.clientId !== client.id) {
        return oauthError(reply, 400, "invalid_grant");
      }
      return issueTokens(fastify, reply, request, validated.userId, client, null, validated.id);
    }

    if (grantType === DEVICE_CODE_GRANT) {
      const deviceCode = field(body, "device_code");
      if (!deviceCode) return oauthError(reply, 400, "invalid_request", "device_code is required");
      const hash = await sha256Hex(deviceCode);
      const row = await db.query.oauthDeviceCodes.findFirst({
        where: eq(oauthDeviceCodes.deviceCodeHash, hash),
      });
      if (!row || row.clientId !== client.id || row.status === "used") {
        return oauthError(reply, 400, "invalid_grant");
      }
      if (row.expiresAt.getTime() <= Date.now()) return oauthError(reply, 400, "expired_token");
      if (row.status === "denied") return oauthError(reply, 400, "access_denied");
      if (row.status === "pending") {
        const now = new Date();
        const tooSoon =
          row.lastPolledAt !== null &&
          now.getTime() - row.lastPolledAt.getTime() < DEVICE_POLL_INTERVAL_SECONDS * 1000;
        await db
          .update(oauthDeviceCodes)
          .set({ lastPolledAt: now })
          .where(eq(oauthDeviceCodes.deviceCodeHash, hash));
        return oauthError(reply, 400, tooSoon ? "slow_down" : "authorization_pending");
      }
      // Approved: hand out tokens exactly once.
      const [claimed] = await db
        .update(oauthDeviceCodes)
        .set({ status: "used" })
        .where(
          and(eq(oauthDeviceCodes.deviceCodeHash, hash), eq(oauthDeviceCodes.status, "approved")),
        )
        .returning();
      if (!claimed?.userId) return oauthError(reply, 400, "invalid_grant");
      return issueTokens(fastify, reply, request, claimed.userId, client, claimed.scope);
    }

    return oauthError(reply, 400, "unsupported_grant_type");
  });

  // ── Revocation (RFC 7009) ─────────────────────────────────────────────────
  fastify.post("/oauth/revoke", async (request, reply) => {
    const client = findClient(field(request.body, "client_id"));
    if (!client) return oauthError(reply, 401, "invalid_client");
    const token = field(request.body, "token");
    if (token) {
      const validated = await fastify.validateRefreshToken(token);
      if (validated && validated.clientId === client.id) {
        await fastify.revokeRefreshToken(validated.id);
      }
    }
    // Unknown or already-revoked tokens are not an error (§2.2).
    return reply.status(200).send({});
  });
}
