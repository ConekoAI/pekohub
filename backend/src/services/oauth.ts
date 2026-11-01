/**
 * OAuth 2.0 authorization server: the client registry and the pure helpers
 * behind `routes/auth/oauth-server.ts`.
 *
 * Two first-party public clients sign users in:
 *   - `peko-desktop` — authorization code + PKCE (RFC 7636) with a
 *     loopback redirect (RFC 8252 §7.3: any port on 127.0.0.1 / [::1] /
 *     localhost).
 *   - `peko-cli` — the device authorization grant (RFC 8628), so
 *     `peko runtime register` works on a machine without a browser.
 * Both refresh with rotating refresh tokens bound to the client.
 */

export const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export type GrantType = "authorization_code" | "refresh_token" | typeof DEVICE_CODE_GRANT;

export interface OAuthClient {
  id: string;
  /** Shown on the consent page: "<name> wants to sign in as …". */
  name: string;
  grants: GrantType[];
  /** Accepts loopback redirect URIs on any port. */
  loopbackRedirect: boolean;
}

export const OAUTH_CLIENTS: Record<string, OAuthClient> = {
  "peko-desktop": {
    id: "peko-desktop",
    name: "Peko desktop",
    grants: ["authorization_code", "refresh_token"],
    loopbackRedirect: true,
  },
  "peko-cli": {
    id: "peko-cli",
    name: "Peko CLI",
    grants: [DEVICE_CODE_GRANT, "refresh_token"],
    loopbackRedirect: false,
  },
};

export function findClient(clientId: unknown): OAuthClient | null {
  return typeof clientId === "string" && Object.hasOwn(OAUTH_CLIENTS, clientId)
    ? OAUTH_CLIENTS[clientId]
    : null;
}

export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000;
export const AUTHORIZE_REQUEST_TTL = "10m";
export const DEVICE_CODE_TTL_SECONDS = 10 * 60;
export const DEVICE_POLL_INTERVAL_SECONDS = 5;

/** A redirect URI this client may use; exact `http` loopback for the desktop. */
export function isAllowedRedirectUri(client: OAuthClient, redirectUri: unknown): boolean {
  if (!client.loopbackRedirect || typeof redirectUri !== "string") return false;
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return false;
  }
  return (
    url.protocol === "http:" &&
    ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) &&
    url.hash === "" &&
    url.username === "" &&
    url.password === ""
  );
}

/** Scopes are recorded and echoed, not enforced yet: a token acts for the account. */
export function normalizeScope(scope: unknown): string | null {
  if (typeof scope !== "string") return null;
  const parts = scope.split(/\s+/).filter((part) => /^[\x21\x23-\x5B\x5D-\x7E]+$/.test(part));
  const joined = [...new Set(parts)].join(" ");
  return joined && joined.length <= 256 ? joined : null;
}

const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;
const CHALLENGE_PATTERN = /^[A-Za-z0-9\-_]{43,128}$/;

export function isValidCodeChallenge(challenge: unknown): challenge is string {
  return typeof challenge === "string" && CHALLENGE_PATTERN.test(challenge);
}

/** PKCE S256: `BASE64URL(SHA256(verifier)) == challenge`. */
export async function verifyPkce(verifier: unknown, challenge: string): Promise<boolean> {
  if (typeof verifier !== "string" || !VERIFIER_PATTERN.test(verifier)) return false;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return Buffer.from(digest).toString("base64url") === challenge;
}

/** A random opaque secret (code, device code), base64url. */
export function randomSecret(bytes = 32): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Buffer.from(digest).toString("hex");
}

/** RFC 8628 §6.1: consonants only, so a code never spells a word or confuses 0/O. */
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

/** An 8-letter user code, stored as `ABCDEFGH`, shown as `ABCD-EFGH`. */
export function generateUserCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => USER_CODE_ALPHABET[b % USER_CODE_ALPHABET.length]).join("");
}

/** Accepts what a user types — any case, with or without the hyphen. */
export function normalizeUserCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const code = input.toUpperCase().replace(/[\s-]/g, "");
  return code.length === 8 && [...code].every((c) => USER_CODE_ALPHABET.includes(c))
    ? code
    : null;
}

export function formatUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** `redirectUri` with the query parameters appended (existing query kept). */
export function withQuery(redirectUri: string, params: Record<string, string | undefined>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}
