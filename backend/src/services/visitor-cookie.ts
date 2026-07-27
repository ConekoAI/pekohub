/**
 * Ephemeral visitor cookie for anonymous public-chat sessions
 * (pekohub web chat, PR-A → B1).
 *
 * Browser lands on `/p/<owner>/<principalName>`. They have no
 * PekoHub account. They want their chat history to persist
 * across reloads. PekoHub mints a UUID, sets it as an HttpOnly
 * cookie, and forwards it to the runtime as `x-pekohub-user-id`.
 * The runtime's `Subject::from_bridge_user` projects the UUID to
 * `Subject::User(<uuid>)`, which the chat-log store keys on (see
 * `peko-runtime/peko-rs/chat-log/src/types.rs`). Two browsers
 * with distinct cookies land in distinct chat-log shards, so
 * visitor A cannot see visitor B's session; a single browser
 * returning on the same cookie resumes its own thread.
 *
 * Cookie attributes:
 * - HttpOnly — blocks JS exfil via XSS; we never expose the UUID
 *   to the SPA, only round-trip it through the cookie.
 * - SameSite=Lax — survives `slack.com → pekohub.org` redirects
 *   so a shared link opens correctly. NOT `Strict`.
 * - Secure — HTTPS-only in prod. Dev mode (`http://localhost`)
 *   tolerates the missing Secure flag silently because
 *   `@fastify/cookie` reads `process.env.NODE_ENV`.
 * - Path=/ — the visitor identity spans the SPA regardless of
 *   which public-principal route is current.
 */

import type { FastifyReply, FastifyRequest } from "fastify";

export const VISITOR_COOKIE = "pekohub_visitor";
/** 365 days — long enough that a returning browser resumes its
 *  thread for a year; short enough that we are not minting a
 *  permanent key. Ephemeral identity, not permanent auth. */
const VISITOR_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/**
 * Read the visitor id from the request cookie; if absent, mint a
 * fresh UUID and return it. Does NOT set the cookie — the caller
 * owns that decision so it can also set the cookie on adjacent
 * read paths (e.g. the profile page) without doubling up the
 * `Set-Cookie` header.
 */
export function getOrMintVisitorId(req: FastifyRequest): string {
  const existing = req.cookies?.[VISITOR_COOKIE];
  if (typeof existing === "string" && existing.length > 0 && existing.length <= 128) {
    return existing;
  }
  // crypto.randomUUID is available in Node ≥ 19.4 and any modern
  // browser. We do not pin a runtime version explicitly — the
  // project's engines field is the contract.
  return crypto.randomUUID();
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
function serializeVisitorCookie(id: string): string {
  const maxAge = VISITOR_COOKIE_MAX_AGE_SECONDS;
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return [
    `${VISITOR_COOKIE}=${id}`,
    `Path=/`,
    `Max-Age=${maxAge}`,
    `HttpOnly`,
    `SameSite=Lax`,
  ].join("; ") + secure;
}

/**
 * Set the visitor cookie on the response. Idempotent — passing
 * the same id twice keeps the same `Max-Age` and the same value.
 *
 * Writes to BOTH Fastify's reply (so non-hijacked routes get the
 * cookie via the normal header pipeline) AND to `reply.raw` (so
 * SSE / WebSocket / hijacked response paths also receive it). The
 * duplication is benign: both paths emit the same `Set-Cookie`
 * value, and HTTP lets a response carry multiple Set-Cookie
 * headers with the same name (the browser keeps the latest).
 */
export function setVisitorCookie(reply: FastifyReply, id: string): void {
  reply.setCookie(VISITOR_COOKIE, id, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: VISITOR_COOKIE_MAX_AGE_SECONDS,
  });
  reply.raw.setHeader("Set-Cookie", serializeVisitorCookie(id));
}

/**
 * Convenience wrapper that reads (or mints) and writes in one
 * step. Returns the resulting id. Use on routes that mint a new
 * visitor; pass an existing id through `setVisitorCookie` to
 * refresh the cookie's expiry on a returning visit.
 */
export function readOrSetVisitor(req: FastifyRequest, reply: FastifyReply): string {
  const id = getOrMintVisitorId(req);
  setVisitorCookie(reply, id);
  return id;
}
