import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { createTestDb, resetTables } from "../fixtures/db.js";
import { buildTestApp } from "../fixtures/app.js";
import { createUser } from "../fixtures/factories.js";
import { authHeaders } from "../fixtures/auth.js";
import type { TestDb } from "../fixtures/db.js";

// ─────────────────────────────────────────────────────────────────────────────
// The OAuth authorization server Peko desktop (authorization code + PKCE,
// loopback redirect) and the Peko CLI (device authorization) sign in with.
// ─────────────────────────────────────────────────────────────────────────────

const REDIRECT = "http://localhost:19876/callback";

function pkce() {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function authorizeUrl(params: Record<string, string>) {
  return `/oauth/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: "peko-desktop",
    redirect_uri: REDIRECT,
    code_challenge_method: "S256",
    state: "st4te",
    ...params,
  })}`;
}

function form(body: Record<string, string>) {
  return {
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams(body).toString(),
  };
}

describe("OAuth authorization server", () => {
  let testDb: TestDb;
  let app: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    testDb = await createTestDb();
    app = await buildTestApp({ testDb });
  });

  beforeEach(async () => {
    await resetTables(testDb.client);
  });

  afterAll(async () => {
    await app.close();
    await testDb.client.close();
  });

  /** Walk the desktop flow up to the code the loopback listener receives. */
  async function authorizeAndApprove(challenge: string, headers: { Authorization: string }) {
    const start = await app.inject({ method: "GET", url: authorizeUrl({ code_challenge: challenge }) });
    expect(start.statusCode).toBe(302);
    const consent = new URL(start.headers.location as string);
    expect(consent.pathname).toBe("/authorize");
    const request = consent.searchParams.get("request")!;
    expect(request).toBeTruthy();

    const describe = await app.inject({
      method: "GET",
      url: `/v1/oauth/authorize/describe?request=${encodeURIComponent(request)}`,
    });
    expect(describe.statusCode).toBe(200);
    expect(describe.json().client).toEqual({ id: "peko-desktop", name: "Peko desktop" });

    const decision = await app.inject({
      method: "POST",
      url: "/v1/oauth/authorize/decision",
      headers,
      payload: { request, approve: true },
    });
    expect(decision.statusCode).toBe(200);
    const redirect = new URL(decision.json().redirectTo);
    expect(`${redirect.origin}${redirect.pathname}`).toBe(REDIRECT);
    expect(redirect.searchParams.get("state")).toBe("st4te");
    return redirect.searchParams.get("code")!;
  }

  it("desktop: authorization code + PKCE issues tokens that act for the account", async () => {
    const user = await createUser(testDb.client, { namespace: "alice" });
    const { verifier, challenge } = pkce();
    const code = await authorizeAndApprove(challenge, await authHeaders(user));

    // The desktop posts JSON; form encoding works the same.
    const token = await app.inject({
      method: "POST",
      url: "/oauth/token",
      payload: {
        grant_type: "authorization_code",
        client_id: "peko-desktop",
        code,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      },
    });
    expect(token.statusCode).toBe(200);
    expect(token.headers["cache-control"]).toBe("no-store");
    const body = token.json();
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBe(3600);
    expect(body.refresh_token).toBeTruthy();

    const me = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { Authorization: `Bearer ${body.access_token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().namespace).toBe("alice");

    // The account is told an app signed in.
    const notices = await testDb.client.query("SELECT kind, text FROM notifications WHERE user_id = $1", [user.id]);
    expect(notices.rows).toEqual([
      { kind: "security.sign_in", text: expect.stringContaining("Peko desktop signed in") },
    ]);

    // A code works once.
    const replay = await app.inject({
      method: "POST",
      url: "/oauth/token",
      ...form({
        grant_type: "authorization_code",
        client_id: "peko-desktop",
        code,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      }),
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.json().error).toBe("invalid_grant");
  });

  it("desktop: a wrong code_verifier or redirect_uri is refused", async () => {
    const user = await createUser(testDb.client, { namespace: "alice" });
    const { challenge } = pkce();
    const headers = await authHeaders(user);

    const code = await authorizeAndApprove(challenge, headers);
    const wrongVerifier = await app.inject({
      method: "POST",
      url: "/oauth/token",
      ...form({
        grant_type: "authorization_code",
        client_id: "peko-desktop",
        code,
        redirect_uri: REDIRECT,
        code_verifier: pkce().verifier,
      }),
    });
    expect(wrongVerifier.json().error).toBe("invalid_grant");

    const code2 = await authorizeAndApprove(challenge, headers);
    const wrongRedirect = await app.inject({
      method: "POST",
      url: "/oauth/token",
      ...form({
        grant_type: "authorization_code",
        client_id: "peko-desktop",
        code: code2,
        redirect_uri: "http://localhost:1/other",
        code_verifier: pkce().verifier,
      }),
    });
    expect(wrongRedirect.json().error).toBe("invalid_grant");
  });

  it("authorize: bad clients and redirect targets never reach the redirect URI", async () => {
    const unknownClient = await app.inject({
      method: "GET",
      url: authorizeUrl({ client_id: "evil", code_challenge: pkce().challenge }),
    });
    expect(new URL(unknownClient.headers.location as string).searchParams.get("error")).toBe("invalid_client");

    for (const redirect of ["https://evil.example/cb", "http://evil.example/cb", "http://localhost:1/cb#frag"]) {
      const res = await app.inject({
        method: "GET",
        url: authorizeUrl({ redirect_uri: redirect, code_challenge: pkce().challenge }),
      });
      const location = new URL(res.headers.location as string);
      expect(location.pathname).toBe("/authorize");
      expect(location.searchParams.get("error")).toBe("invalid_redirect_uri");
    }

    // Once the redirect is trusted, protocol errors go back to the app.
    const noPkce = await app.inject({ method: "GET", url: authorizeUrl({}) });
    const location = new URL(noPkce.headers.location as string);
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
    expect(location.searchParams.get("error")).toBe("invalid_request");
    expect(location.searchParams.get("state")).toBe("st4te");
  });

  it("authorize: a denial returns access_denied; deciding needs a signed-in user", async () => {
    const user = await createUser(testDb.client, { namespace: "alice" });
    const start = await app.inject({ method: "GET", url: authorizeUrl({ code_challenge: pkce().challenge }) });
    const request = new URL(start.headers.location as string).searchParams.get("request")!;

    const anonymous = await app.inject({
      method: "POST",
      url: "/v1/oauth/authorize/decision",
      payload: { request, approve: true },
    });
    expect(anonymous.statusCode).toBe(401);

    // The signed request is not an access token.
    const asBearer = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { Authorization: `Bearer ${request}` },
    });
    expect(asBearer.statusCode).toBe(401);

    const denied = await app.inject({
      method: "POST",
      url: "/v1/oauth/authorize/decision",
      headers: await authHeaders(user),
      payload: { request, approve: false },
    });
    expect(new URL(denied.json().redirectTo).searchParams.get("error")).toBe("access_denied");
  });

  it("refresh tokens rotate, stay with their client, and are not the website's cookie", async () => {
    const user = await createUser(testDb.client, { namespace: "alice" });
    const { verifier, challenge } = pkce();
    const code = await authorizeAndApprove(challenge, await authHeaders(user));
    const first = (
      await app.inject({
        method: "POST",
        url: "/oauth/token",
        ...form({
          grant_type: "authorization_code",
          client_id: "peko-desktop",
          code,
          redirect_uri: REDIRECT,
          code_verifier: verifier,
        }),
      })
    ).json();

    const otherClient = await app.inject({
      method: "POST",
      url: "/oauth/token",
      ...form({ grant_type: "refresh_token", client_id: "peko-cli", refresh_token: first.refresh_token }),
    });
    expect(otherClient.json().error).toBe("invalid_grant");

    const asCookie = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      cookies: { pekohub_refresh: first.refresh_token },
    });
    expect(asCookie.statusCode).toBe(401);

    const rotated = await app.inject({
      method: "POST",
      url: "/oauth/token",
      ...form({ grant_type: "refresh_token", client_id: "peko-desktop", refresh_token: first.refresh_token }),
    });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json().refresh_token).not.toBe(first.refresh_token);

    // A refresh racing that one (or a retry after a lost response) presents
    // the old token again moments later: it still refreshes, and the
    // session it raced stays signed in.
    const raced = await app.inject({
      method: "POST",
      url: "/oauth/token",
      ...form({ grant_type: "refresh_token", client_id: "peko-desktop", refresh_token: first.refresh_token }),
    });
    expect(raced.statusCode).toBe(200);
    const racedAgain = await app.inject({
      method: "POST",
      url: "/oauth/token",
      ...form({ grant_type: "refresh_token", client_id: "peko-desktop", refresh_token: raced.json().refresh_token }),
    });
    expect(racedAgain.statusCode).toBe(200);

    // Revocation (sign out) ends the session.
    const second = rotated.json().refresh_token;
    const revoke = await app.inject({
      method: "POST",
      url: "/oauth/revoke",
      ...form({ client_id: "peko-desktop", token: second }),
    });
    expect(revoke.statusCode).toBe(200);
    const afterRevoke = await app.inject({
      method: "POST",
      url: "/oauth/token",
      ...form({ grant_type: "refresh_token", client_id: "peko-desktop", refresh_token: second }),
    });
    expect(afterRevoke.json().error).toBe("invalid_grant");
  });

  it("a spent token presented after its successor moved on signs the account out everywhere", async () => {
    const user = await createUser(testDb.client, { namespace: "alice" });
    const { verifier, challenge } = pkce();
    const code = await authorizeAndApprove(challenge, await authHeaders(user));
    const refresh = (refresh_token: string) =>
      app.inject({
        method: "POST",
        url: "/oauth/token",
        ...form({ grant_type: "refresh_token", client_id: "peko-desktop", refresh_token }),
      });
    const first = (
      await app.inject({
        method: "POST",
        url: "/oauth/token",
        ...form({
          grant_type: "authorization_code",
          client_id: "peko-desktop",
          code,
          redirect_uri: REDIRECT,
          code_verifier: verifier,
        }),
      })
    ).json().refresh_token;
    const second = (await refresh(first)).json().refresh_token;
    const third = (await refresh(second)).json().refresh_token;

    // `first` was replaced by `second`, which is itself spent: a copy of an
    // old token is in someone else's hands.
    expect((await refresh(first)).json().error).toBe("invalid_grant");
    expect((await refresh(third)).json().error).toBe("invalid_grant");
  });

  it("CLI: device authorization — pending, slow_down, approval, one-time tokens", async () => {
    const user = await createUser(testDb.client, { namespace: "bob" });
    const start = await app.inject({
      method: "POST",
      url: "/oauth/device/code",
      ...form({ client_id: "peko-cli" }),
    });
    expect(start.statusCode).toBe(200);
    const device = start.json();
    expect(device.user_code).toMatch(/^[B-Z]{4}-[B-Z]{4}$/);
    expect(new URL(device.verification_uri).pathname).toBe("/device");
    expect(device.verification_uri_complete).toContain(encodeURIComponent(device.user_code));
    expect(device.interval).toBe(5);

    const poll = () =>
      app.inject({
        method: "POST",
        url: "/oauth/token",
        ...form({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: "peko-cli", device_code: device.device_code }),
      });
    expect((await poll()).json().error).toBe("authorization_pending");
    expect((await poll()).json().error).toBe("slow_down");

    // The user types the code in any case, without the hyphen.
    const typed = device.user_code.replace("-", "").toLowerCase();
    const described = await app.inject({ method: "GET", url: `/v1/oauth/device/describe?user_code=${typed}` });
    expect(described.statusCode).toBe(200);
    expect(described.json().client.name).toBe("Peko CLI");

    const approve = await app.inject({
      method: "POST",
      url: "/v1/oauth/device/decision",
      headers: await authHeaders(user),
      payload: { user_code: typed, approve: true },
    });
    expect(approve.json().status).toBe("approved");

    const tokens = await poll();
    expect(tokens.statusCode).toBe(200);
    const me = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { Authorization: `Bearer ${tokens.json().access_token}` },
    });
    expect(me.json().namespace).toBe("bob");

    expect((await poll()).json().error).toBe("invalid_grant");
    // A decided code can't be decided again.
    const again = await app.inject({ method: "GET", url: `/v1/oauth/device/describe?user_code=${typed}` });
    expect(again.statusCode).toBe(404);
  });

  it("CLI: a denied device code answers access_denied; grants are per client", async () => {
    const user = await createUser(testDb.client, { namespace: "bob" });
    const device = (
      await app.inject({ method: "POST", url: "/oauth/device/code", ...form({ client_id: "peko-cli" }) })
    ).json();
    await app.inject({
      method: "POST",
      url: "/v1/oauth/device/decision",
      headers: await authHeaders(user),
      payload: { user_code: device.user_code, approve: false },
    });
    const denied = await app.inject({
      method: "POST",
      url: "/oauth/token",
      ...form({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: "peko-cli", device_code: device.device_code }),
    });
    expect(denied.json().error).toBe("access_denied");

    const desktopDevice = await app.inject({
      method: "POST",
      url: "/oauth/device/code",
      ...form({ client_id: "peko-desktop" }),
    });
    expect(desktopDevice.json().error).toBe("invalid_client");

    const unknownGrant = await app.inject({
      method: "POST",
      url: "/oauth/token",
      ...form({ grant_type: "password", client_id: "peko-desktop" }),
    });
    expect(unknownGrant.json().error).toBe("unauthorized_client");
  });
});
