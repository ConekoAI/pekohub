# ADR-007: The Hub is an OAuth authorization server for Peko desktop and the CLI

Date: 2026-11-01
Status: Accepted
Context doc: `docs/GAP_MAP_2026-11.md` (C1, C2)

## Context

Peko desktop signs in to PekoHub with OAuth 2.0 + PKCE against `/oauth/authorize` and
`/oauth/token`, and the runtime registers with the Hub under an account
(`POST /v1/runtimes/register`, runtime ADR-081). The Hub had neither OAuth route. Its only
sign-in was the website's own GitHub/Google login, so registering a runtime meant minting a
`pkr_` API key on the website and pasting it into the CLI or desktop.

## Decision

1. **The Hub is an authorization server** for a fixed registry of first-party public
   clients (`services/oauth.ts`):
   - `peko-desktop`: authorization code with PKCE S256 (RFC 7636). Redirect URIs are
     loopback `http` URIs on any port (RFC 8252 §7.3).
   - `peko-cli`: the device authorization grant (RFC 8628), for machines without a browser
     or for a terminal user.
   No third-party clients, no client secrets, no dynamic registration.
2. **Consent happens on the website.** `/oauth/authorize` validates the client and redirect
   URI, then sends the browser to `/authorize` carrying the request as a ten-minute signed
   token, so the Hub stores nothing until the user decides. Errors before the redirect URI
   is trusted go to the Hub's own page, never to the redirect target. The device flow's
   `verification_uri` is the website's `/device`.
3. **Tokens.** Access tokens are the Hub's usual JWTs (`sub`, `namespace`) plus `client_id`,
   one hour long, accepted everywhere a website token is. Refresh tokens reuse the
   rotating, reuse-detecting refresh tokens of ADR-001, now bound to a `client_id`: only
   that client refreshes them, and the website's cookie endpoint refuses them.
   `/oauth/revoke` (RFC 7009) is sign-out. Authorization codes (five minutes) and device
   codes (ten minutes) are stored as SHA-256 digests and redeemed atomically, once.
4. **Scopes are recorded, not enforced.** A token acts for the account. Narrow scopes come
   when a third-party client exists.
5. API keys stay, for automation.

## Consequences

- The desktop signs in and registers its runtime in one flow. `peko runtime register` can
  show a code instead of asking for a key.
- Signed tokens sharing the JWT secret carry a `typ`; `authenticate` accepts only tokens
  without one, so an authorize request can't be used as an access token.
- `/oauth/*` gets its own per-IP rate limit (60/min), looser than `/v1/auth/*` because
  device polling runs every five seconds.
