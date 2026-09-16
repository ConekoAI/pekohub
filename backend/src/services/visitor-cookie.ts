/**
 * Ephemeral visitor cookie for anonymous public-chat sessions
 * (pekohub web chat, PR-A → B1; hardened by ADR-058 D5).
 *
 * Browser lands on `/p/<owner>/<principalName>`. They have no
 * PekoHub account. They want their chat history to persist
 * across reloads. PekoHub mints an id, sets it as an HttpOnly
 * cookie, and signs it into the bridge JWT (`kind: "visitor"`,
 * `sub: <visitorId>`). The runtime projects the id to a
 * user-identity shard keyed by the chat-log store. Two browsers
 * with distinct cookies land in distinct shards, so visitor A
 * cannot see visitor B's session; a single browser returning on
 * the same cookie resumes its own thread.
 *
 * ADR-058 D5 — the cookie value is HMAC-SIGNED:
 *
 *   pekohub_visitor = v1.<id>.<base64url(HMAC-SHA256(key, "v1.<id>"))>
 *
 * where `key` is derived from JWT_SECRET via HKDF-SHA256 (same
 * approach as `bridge-token.ts`, distinct info string). A cookie
 * whose signature does not verify — including a victim's hub UUID,
 * a `principal:did:key:...` string, or the literal `local` pasted
 * into the cookie by an attacker — is treated as ABSENT and a
 * fresh hub-minted id is issued instead. Client-supplied ids are
 * never trusted, so a forged cookie can no longer be laundered
 * into the bridge token's `sub`.
 *
 * Cookie attributes:
 * - HttpOnly — blocks JS exfil via XSS; we never expose the id
 *   to the SPA, only round-trip it through the cookie.
 * - SameSite=Lax — survives `slack.com → pekohub.org` redirects
 *   so a shared link opens correctly. NOT `Strict`.
 * - Secure — HTTPS-only in prod. Dev mode (`http://localhost`)
 *   tolerates the missing Secure flag silently because
 *   `@fastify/cookie` reads `process.env.NODE_ENV`.
 * - Path=/ — the visitor identity spans the SPA regardless of
 *   which public-principal route is current.
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { hkdfFromJwtSecret } from "./bridge-token.js";

export const VISITOR_COOKIE = "pekohub_visitor";
/** 365 days — long enough that a returning browser resumes its
 *  thread for a year; short enough that we are not minting a
 *  permanent key. Ephemeral identity, not permanent auth. */
const VISITOR_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/** HKDF domain separation for the cookie HMAC key. Distinct from the
 *  bridge-token info string so the two keys are independent. */
const VISITOR_HMAC_INFO = "pekohub-visitor-cookie-hmac-v1";
/** Cookie value format version prefix. */
const VISITOR_COOKIE_VERSION = "v1";
/** Hub-minted visitor ids are url-safe, 8–64 chars. `randomUUID()`
 *  output (36 chars) satisfies this; the bound exists so a bloated
 *  or control-char-laden client cookie can never round-trip. */
const VISITOR_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** HMAC-SHA256 key for visitor cookie signatures, HKDF-derived from
 *  the JWT secret (same derivation style as the bridge signing key). */
function visitorHmacKey(jwtSecret: string): Uint8Array {
  return hkdfFromJwtSecret(jwtSecret, VISITOR_HMAC_INFO, 32);
}

/** Serialize `v1.<id>.<base64url hmac>` for a hub-minted id. */
export function signVisitorId(id: string, jwtSecret: string): string {
  const preImage = `${VISITOR_COOKIE_VERSION}.${id}`;
  const mac = createHmac("sha256", Buffer.from(visitorHmacKey(jwtSecret)))
    .update(preImage, "utf8")
    .digest();
  return `${preImage}.${Buffer.from(mac).toString("base64url")}`;
}

/**
 * Verify a cookie value and return the visitor id it carries, or
 * `null` when the value is malformed, the id fails the charset
 * check, or the HMAC does not verify. Constant-time comparison on
 * the MAC; a `null` result always means "mint a fresh id".
 */
export function verifyVisitorCookie(
  value: string,
  jwtSecret: string,
): string | null {
  // Length bound first — keeps the regex and split cheap, and the
  // whole cookie must stay ≤ 128 chars by construction.
  if (value.length === 0 || value.length > 128) return null;
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [version, id, mac] = parts;
  if (version !== VISITOR_COOKIE_VERSION) return null;
  if (!VISITOR_ID_RE.test(id)) return null;
  const expected = signVisitorId(id, jwtSecret);
  const a = Buffer.from(value, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return id;
}

/** Mint a fresh visitor id. crypto.randomUUID is available in
 *  Node ≥ 19.4 and any modern browser; its 36-char output matches
 *  VISITOR_ID_RE. */
function mintVisitorId(): string {
  return randomUUID();
}

/**
 * Read the visitor id from the request cookie; if absent or
 * invalid (forged, malformed, wrong signature), mint a fresh id
 * and return it. Does NOT set the cookie — the caller owns that
 * decision so it can also set the cookie on adjacent read paths
 * (e.g. the profile page) without doubling up the `Set-Cookie`
 * header.
 *
 * The returned id is ALWAYS hub-minted or HMAC-verified — never a
 * client-supplied string (ADR-058 D5).
 */
export function getOrMintVisitorId(
  req: FastifyRequest,
  jwtSecret: string,
): string {
  const existing = req.cookies?.[VISITOR_COOKIE];
  if (typeof existing === "string") {
    const verified = verifyVisitorCookie(existing, jwtSecret);
    if (verified !== null) return verified;
  }
  return mintVisitorId();
}

/**
 * Serialize a Set-Cookie header value matching @fastify/cookie's
 * format, so we can write it directly to `reply.raw` for routes
 * that hijack the response (PR-B1: the public-chat SSE stream).
 * @fastify/cookie stores cookies in an internal Symbol-keyed Map
 * and only flushes them in `onSend`; a hijacked response never
 * runs that path. Mirroring the serialization here is preferable
 * to leaking the cookie plugin's internal symbols.
 */
function serializeVisitorCookie(signedValue: string): string {
  const maxAge = VISITOR_COOKIE_MAX_AGE_SECONDS;
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return [
    `${VISITOR_COOKIE}=${signedValue}`,
    `Path=/`,
    `Max-Age=${maxAge}`,
    `HttpOnly`,
    `SameSite=Lax`,
  ].join("; ") + secure;
}

/**
 * Set the visitor cookie on the response. Idempotent — passing
 * the same id twice keeps the same `Max-Age` and the same value.
 * The id is HMAC-signed before serialization (ADR-058 D5); callers
 * pass the raw id returned by `getOrMintVisitorId`.
 *
 * Writes to BOTH Fastify's reply (so non-hijacked routes get the
 * cookie via the normal header pipeline) AND to `reply.raw` (so
 * SSE / WebSocket / hijacked response paths also receive it). The
 * duplication is benign: both paths emit the same `Set-Cookie`
 * value, and HTTP lets a response carry multiple Set-Cookie
 * headers with the same name (the browser keeps the latest).
 */
export function setVisitorCookie(
  reply: FastifyReply,
  id: string,
  jwtSecret: string,
): void {
  const signedValue = signVisitorId(id, jwtSecret);
  reply.setCookie(VISITOR_COOKIE, signedValue, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: VISITOR_COOKIE_MAX_AGE_SECONDS,
  });
  reply.raw.setHeader("Set-Cookie", serializeVisitorCookie(signedValue));
}

/**
 * Convenience wrapper that reads (or mints) and writes in one
 * step. Returns the resulting (verified or freshly-minted) id.
 * Use on routes that mint a new visitor; pass an existing id
 * through `setVisitorCookie` to refresh the cookie's expiry on a
 * returning visit.
 */
export function readOrSetVisitor(
  req: FastifyRequest,
  reply: FastifyReply,
  jwtSecret: string,
): string {
  const id = getOrMintVisitorId(req, jwtSecret);
  setVisitorCookie(reply, id, jwtSecret);
  return id;
}
