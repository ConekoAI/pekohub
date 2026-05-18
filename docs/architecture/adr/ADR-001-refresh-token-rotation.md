# ADR-001: Refresh Token Rotation for Long-Lived Sessions

**Status**: Implemented  
**Date**: 2026-05-18  
**Last Updated**: 2026-05-18  
**Author**: Core team  
**Reviewers**: TBD  
**Depends On**: Phase 2 auth implementation (SEC-001 through SEC-024)

---

## Context

Phase 2's auth system uses JWTs issued at login with a 24-hour expiry stored in a cookie. This satisfies the security requirement SEC-002 ("Registry access tokens MUST expire within 24 hours") but creates a poor user experience: users must re-authenticate every 24 hours, even for active daily use.

This is inconsistent with modern web application patterns where OAuth-based logins (GitHub, Google) issue short-lived access tokens paired with long-lived refresh tokens, enabling sessions that persist for weeks or months without user friction.

---

## Problem Statement

1. **Poor UX**: Users must re-login every 24 hours. For a registry used daily, this is friction that harms adoption.
2. **SEC-002 constraint**: The security requirement mandates access tokens expire within 24h — we cannot simply increase the JWT lifetime.
3. **No revocation mechanism**: If a token is compromised, there is no way to invalidate it short of changing the JWT secret.
4. **No refresh endpoint**: The current `/api/v1/auth/refresh` does not exist; every auth is a full OAuth round-trip.

---

## Decision

Implement **refresh token rotation** with the following characteristics:

### Token Architecture

| Token | Lifetime | Storage | Purpose |
|-------|----------|---------|---------|
| Access JWT | 15 minutes | Memory / localStorage | Authorizes API requests |
| Refresh Token | 30 days | HTTP-only secure cookie | Obtain new access JWT without re-login |

### Refresh Token Rotation

On every `/api/v1/auth/refresh` call:
1. Validate the incoming refresh token from the cookie (check hash against DB, verify expiry)
2. **Rotate**: invalidate the presented refresh token in the database
3. Issue a new refresh token (new random value, new expiry)
4. Issue a new access JWT
5. Set the new refresh token in a new cookie

### Detection of Token Theft (Rotation Anomaly)

If a refresh token is used twice — once by the legitimate user and once by an attacker who already consumed it — the second use is detected:
- The first (legitimate) request succeeds, rotates, and invalidates the token
- The second (attacker) request fails with 401
- As a security measure, **all refresh tokens for that user are revoked**, forcing re-authentication

### Revocation

- **Logout**: Deletes the refresh token record from the database
- **Password change** (future): Revokes all refresh tokens for that user
- **Device management** (future): Per-device revoke via token ID

### Database Schema

```sql
CREATE TABLE refresh_tokens (
  id          TEXT PRIMARY KEY,       -- random UUID, not the token itself
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL,          -- bcrypt hash of the actual token value
  device_info TEXT,                  -- user agent / device description
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,           -- NULL = active
  rotated_from TEXT REFERENCES refresh_tokens(id)  -- for audit trail
);

CREATE INDEX idx_refresh_tokens_user_id ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_hash ON refresh_tokens(token_hash);
```

---

## Backend Changes

### New Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/auth/refresh` | Rotate refresh token, issue new access JWT |
| `POST` | `/api/v1/auth/logout` | Revoke refresh token, clear cookies |

### Modified Endpoints

| Endpoint | Change |
|----------|--------|
| `GET /api/v1/auth/:provider/callback` | Issue access JWT (15min) + refresh token cookie (30 days) instead of 24h JWT |
| `POST /api/v1/auth/api-keys` | API keys are long-lived and unaffected by refresh flow |

### Auth Plugin Changes (`src/plugins/auth.ts`)

- `authenticate()` remains unchanged — it still verifies the access JWT
- `reply.jwtSign()` is still used for access tokens (15 min expiry)
- New `refreshTokens` table added to schema
- New `issueRefreshToken(userId)` / `validateRefreshToken(token)` / `revokeRefreshToken(token)` helpers

### Security Properties

- **Access JWT**: 15 min, stateless verification, no DB lookup
- **Refresh token**: Single-use, rotated on every refresh, stored as bcrypt hash (not plaintext)
- **SEC-002 compliance**: Access token expires in 15 min (< 24h)
- **SEC-003 alignment**: Refresh token revocation provides token kill-switch; full audit logging of auth events

---

## Frontend Changes

### Token Management

1. **Storage**: Access JWT stored in `localStorage` (not HTTP-only — must be readable by API client)
2. **Refresh cookie**: HTTP-only, never accessible to JavaScript
3. **Interceptor** (Axios or fetch wrapper):
   - On HTTP 401 response → call `POST /api/v1/auth/refresh`
   - On success: store new access JWT, retry original request
   - On failure: clear tokens, redirect to login

### Flow

```
1. User lands on site → /me returns 401 (no token)
2. User clicks "Sign in with GitHub" → OAuth redirect
3. OAuth callback → receives access JWT (15 min) + refresh cookie (30 days)
4. Frontend stores access JWT, sets refresh cookie (HTTP-only)
5. User makes API calls → access JWT in Authorization header
6. Access JWT expires (15 min) → API returns 401
7. Frontend interceptor → POST /api/v1/auth/refresh
8. Server rotates refresh token, returns new access JWT
9. Frontend retries original request → success
10. Repeat steps 6-9 until refresh token expires (30 days) or is revoked
```

---

## Out of Scope (Future)

- Per-device token management UI
- "Remember this device" checkbox
- Concurrent session limits
- Biometric / WebAuthn step-up for sensitive operations
- Refresh token family tracking (detect token theft across families)

---

## Alternatives Considered

### 1. Silent OAuth Re-authentication
Redirect to OAuth provider in an iframe to get a new token silently. **Rejected**: OAuth providers (GitHub, Google) discourage or block iframe-based auth; adds latency and external dependency to every refresh.

### 2. Longer JWT Expiry (e.g., 30 days)
Bypass refresh tokens entirely. **Rejected**: Violates SEC-002 (24h max), and a compromised token lives for 30 days with no revocation path.

### 3. Session IDs Server-Side
Use a opaque session ID stored server-side instead of JWTs. **Rejected**: Requires session store (Redis/DB) on every API call; loses statelessness benefits of JWTs; more operational complexity.

### 4. Refresh Tokens Without Rotation
Issue a refresh token that can be reused indefinitely without rotation. **Rejected**: If stolen, attacker has indefinite access. Rotation detects theft on second use.

---

## Consequences

### Positive
- Users stay logged in for 30 days of inactivity (vs. 24h today)
- Stolen refresh tokens are usable at most once before detection
- Satisfies SEC-002 with a 15-min access token
- Supports explicit logout and future revocation use cases

### Negative
- Increased auth complexity (new table, rotation logic, interceptor)
- Refresh flow must be implemented in all API clients (CLI needs refresh-aware HTTP layer)
- A stolen refresh token gives attacker one successful use before revocation
- DB writes on every token refresh (rotate = 1 update per refresh)

### Tradeoffs
The rotation complexity is the standard cost of stateless JWT auth with long-lived sessions. The alternative (session IDs, longer tokens) either sacrifices statelessness or creates greater security risk.

---

## Implementation Plan

### Phase 1 — Database & Schema (`backend/src/db/schema.ts`)

**Task 1.1**: Add `refreshTokens` table to Drizzle schema.

```typescript
export const refreshTokens = pgTable('refresh_tokens', {
  id: text('id').primaryKey(), // random UUID
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: varchar('token_hash', { length: 256 }).notNull(), // bcrypt hash
  deviceInfo: text('device_info'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  rotatedFrom: text('rotated_from').references((): AnyPgColumn => refreshTokens.id),
});
```

**Task 1.2**: Generate and run Drizzle migration.

```bash
cd backend
npx drizzle-kit generate
npx drizzle-kit migrate
```

---

### Phase 2 — Auth Plugin (`backend/src/plugins/auth.ts`)

**Task 2.1**: Add refresh token helpers to the auth plugin.

- `issueRefreshToken(userId: number, deviceInfo?: string)` — generates a 64-byte random token, bcrypt-hashes it, inserts into `refresh_tokens`, returns the plaintext token.
- `validateRefreshToken(token: string)` — looks up by hash, checks expiry/revocation, returns `{ id, userId }`.
- `revokeRefreshToken(id: string)` — sets `revoked_at = NOW()`.
- `revokeAllUserRefreshTokens(userId: number)` — sets `revoked_at = NOW()` for all active tokens of that user.
- `rotateRefreshToken(oldId: string, userId: number, deviceInfo?: string)` — revokes old token, issues new one, sets `rotated_from`.

**Task 2.2**: Update `FastifyInstance` augmentation in `backend/src/types/fastify.d.ts` to expose new helpers.

**Task 2.3**: Update `authenticate()` to support **only** Bearer JWT access tokens (remove cookie-based JWT auth from `authenticate()` — the session cookie is being replaced by the refresh-token cookie).

---

### Phase 3 — OAuth Routes (`backend/src/routes/auth/oauth.ts`)

**Task 3.1**: Modify `GET /:provider/callback`.

- After upserting user, issue:
  - **Access JWT** (15 min expiry) → returned in redirect URL query param `token=`.
  - **Refresh token** (30 days) → set as HTTP-only cookie `pekohub_refresh`.
- Remove the old `pekohub_session` cookie logic.

**Task 3.2**: Add `POST /api/v1/auth/refresh`.

```
1. Read `pekohub_refresh` cookie.
2. If missing → 401.
3. Call `validateRefreshToken()`.
4. If invalid/expired/revoked → 401.
5. Rotate: call `rotateRefreshToken()`.
6. Issue new access JWT (15 min).
7. Set new `pekohub_refresh` cookie.
8. Return `{ token: <access_jwt> }`.
```

**Task 3.3**: Update `POST /api/v1/auth/logout`.

- Read `pekohub_refresh` cookie.
- If present, revoke the token in DB.
- Clear both `pekohub_refresh` and legacy `pekohub_session` cookies (defensive).
- Return `{ success: true }`.

**Task 3.4**: Keep `GET /api/v1/auth/me` unchanged (still uses `authenticate()` with Bearer JWT).

---

### Phase 4 — Token Theft Detection

**Task 4.1**: In `validateRefreshToken()`, if a token is presented that has already been revoked (i.e. `revoked_at IS NOT NULL`):

- Log a security event via `audit.logSecurityEvent()` (or console.warn if audit service not ready).
- Call `revokeAllUserRefreshTokens(userId)`.
- Return 401 with `{ error: 'Token reuse detected. All sessions revoked.' }`.

**Task 4.2**: Ensure atomicity: the lookup + revocation should happen in a single transaction or with a row-level lock to prevent race conditions on concurrent refresh requests.

---

### Phase 5 — Frontend (`frontend/src/`)

**Task 5.1**: Update `frontend/src/lib/api.ts`.

- Keep `getAuthToken()` / `setAuthToken()` / `clearAuthToken()` for access JWT in `localStorage`.
- Add a **response interceptor** in `fetchJson()`:
  - On HTTP 401, call `POST /api/v1/auth/refresh`.
  - On success: store new access JWT, retry original request.
  - On failure: clear tokens, redirect to `/` (home).
- Ensure `credentials: 'include'` is set on all requests so the refresh cookie is sent.

**Task 5.2**: Update `frontend/src/routes/auth/callback.tsx`.

- No change needed — it already stores the `token` query param in `localStorage`. The refresh cookie is set automatically by the browser.

**Task 5.3**: Update `frontend/src/hooks/useAuth.ts`.

- `logout()` already calls `api.logout()` — ensure it also clears `localStorage` token (already handled in `api.logout()` → `clearAuthToken()`).

**Task 5.4**: Add a `useEffect` in `useAuth` (or a global fetch wrapper) to handle the 401 → refresh → retry loop without infinite loops (use a flag to prevent multiple concurrent refresh calls).

---

### Phase 6 — Tests

**Task 6.1**: Update `backend/src/routes/auth/__tests__/oauth.test.ts`.

- Mock `refresh_tokens` table queries/inserts.
- Add tests for:
  - `POST /refresh` with valid refresh cookie → returns new access token.
  - `POST /refresh` with missing cookie → 401.
  - `POST /refresh` with revoked token → 401 + all tokens revoked.
  - `POST /logout` clears refresh cookie.

**Task 6.2**: Add unit tests for auth plugin helpers in `backend/src/plugins/__tests__/auth.test.ts` (create if missing):

- `issueRefreshToken` stores bcrypt hash.
- `validateRefreshToken` rejects expired tokens.
- `validateRefreshToken` triggers family revocation on reuse.

**Task 6.3**: Add frontend tests in `frontend/src/hooks/useAuth.test.tsx` or `frontend/src/lib/api.test.ts`:

- 401 response triggers refresh call.
- Failed refresh redirects to login.

---

### Phase 7 — Configuration & Deployment

**Task 7.1**: Add new env vars to `backend/.env.example` (if any needed for token lifetimes; default to 15 min / 30 days in code).

**Task 7.2**: Update CORS settings in `backend/src/index.ts` to ensure `credentials: true` remains enabled (already set).

**Task 7.3**: Verify cookie settings in production:

- `pekohub_refresh`: `httpOnly: true`, `secure: true` (production), `sameSite: 'lax'`.
- No `pekohub_session` cookie should be issued anymore.

---

### Rollout Checklist

| # | Item | Status |
|---|------|--------|
| 1 | Migration applied to staging DB | ✅ |
| 2 | Backend deploys without errors | ✅ |
| 3 | OAuth login flow works end-to-end | ✅ |
| 4 | Access token expires after 15 min, refresh succeeds | ✅ |
| 5 | Logout revokes token and clears cookie | ✅ |
| 6 | Token reuse detection triggers family revocation | ✅ |
| 7 | Frontend interceptor handles 401 gracefully | ✅ |
| 8 | API keys still work (unaffected) | ✅ |
| 9 | Old `pekohub_session` cookies are ignored / cleared | ✅ |

### Implementation Status

**Completed:**
- `refreshTokens` table added to `backend/src/db/schema.ts`
- Migration `backend/drizzle/0002_mean_kabuki.sql` generated
- Auth plugin helpers: `issueRefreshToken`, `validateRefreshToken`, `revokeRefreshToken`, `revokeAllUserRefreshTokens`, `rotateRefreshToken`
- `POST /api/v1/auth/refresh` endpoint (cookie → rotates → returns new access JWT)
- `POST /api/v1/auth/logout` updated to revoke DB token and clear both cookies
- `GET /:provider/callback` issues 15-min access JWT (url param) + 30-day refresh cookie
- `auditService.logSecurityEvent()` added for token theft detection
- Frontend `fetchJson` 401 interceptor with deduped concurrent refresh retry
- Integration tests covering: missing cookie (401), invalid token (401), successful rotation, token reuse revocation, logout revocation

**Known Issues / Technical Debt:**
- `sha256Prefix` in `auth.ts` is defined but unused — the ADR described a SHA-256 prefix for O(1) token lookup, but `validateRefreshToken` currently does O(n) bcrypt comparisons across all active + revoked tokens per user
- `validateRefreshToken` loads all active/revoked token candidates into memory before matching — performance degrades for users with many historical tokens
- Token theft revocation (`revokeAllUserRefreshTokens`) is non-atomic and has a race window between the detection check and the bulk update — two concurrent stolen-token uses could both pass validation before either completes revocation
- `refreshTokens` table has no application-level indexes beyond the self-referencing FK on `rotated_from`; a covering index on `(user_id, revoked_at, expires_at)` would improve the common-query path

---

## Implementation Priority

This ADR addresses a UX gap (SEC-002 compliance is already met by the 24h JWT, but experience is poor) and should be implemented as part of Phase 2 polish. It does not block any P0 criteria but improves the production readiness of the auth system.