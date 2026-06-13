# Issue 002: Chat Proxy Drops `x-pekohub-user-id`, Breaking Private-Instance ACL

**Status:** Closed (fixed in pekohub & peko-runtime)  
**Priority:** P2  
**Area:** Tunnel Proxy / Chat Route / Private-Instance Authorization  
**Related:** `backend/src/services/tunnel-router.ts`, `backend/src/routes/api/instances.ts`, `backend/src/plugins/auth.ts` (caller: `peko-runtime/tests/tunnel_e2e.rs::test_e2e_tunnel_chat_with_llm`)

---

## 1. Problem Summary

`POST /v1/instances/:id/chat` returns 200 with `{"error":"Forbidden: Authentication required"}` in the SSE body whenever the instance is `private` (the runtime's default), even when the caller presents a valid JWT.

Reproduction (from `peko-runtime`'s `tunnel_e2e.rs::test_e2e_tunnel_chat_with_llm`):
1. Create a user via `/test/create-user` with namespace `e2etestuser`.
2. Create a runtime record owned by that user.
3. Start the tunnel; it announces the instance (the runtime defaults to `exposure=private` — see `peko-runtime/src/tunnel/dispatcher.rs:180`).
4. Send `POST /v1/instances/<id>/chat` with `Authorization: Bearer <jwt>` and a chat body.
5. Response body:
   ```json
   {"error":"Forbidden: Authentication required"}
   ```
   The HTTP status is `200` because pekohub has already accepted the auth and started the SSE stream; the error is delivered as the first SSE event.

**Impact:** Any private-instance chat (the default for every tunnel-announced instance) is broken. The runtime's defense-in-depth ACL denies the call because pekohub never tells the runtime *who* the caller is. Public instances work — they bypass the ACL — but the runtime defaults to private.

---

## 2. Root Cause Analysis

### 2.1 The Runtime's ACL Needs the Caller's User ID

[`peko-runtime/src/tunnel/dispatcher.rs:765-789`](https://github.com/rlsn/pekobot/blob/master/peko-runtime/src/tunnel/dispatcher.rs) — `check_request_allowed` for a `private` instance:

```rust
InstanceExposure::Private => {
    // Extract user ID from bridge payload (set by PekoHub)
    let user_id = bridge_payload
        .get("headers")
        .and_then(|h| h.get("x-pekohub-user-id"))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    if user_id.is_empty() {
        anyhow::bail!("Authentication required")
    }

    if instance_state.allowed_users.iter().any(|u| u == user_id) {
        Ok(())
    } else {
        anyhow::bail!("Forbidden")
    }
}
```

The runtime looks for `headers["x-pekohub-user-id"]` in the bridge payload. If it's missing or empty → "Authentication required".

### 2.2 The PekoHub Chat Proxy Doesn't Forward That Header

[`backend/src/routes/api/instances.ts:545-599`](https://github.com/ConekoAI/pekohub/blob/master/backend/src/routes/api/instances.ts) — the chat route, after passing its own auth + ACL checks, calls the tunnel proxy:

```ts
await fastify.tunnelRouter.proxyStream(
  instance.runtimeId,
  id,
  instance.name,
  body.data,
  { "content-type": "application/json" },  // ← only this header
  reply,
);
```

And [`backend/src/services/tunnel-router.ts:64-114`](https://github.com/ConekoAI/pekohub/blob/master/backend/src/services/tunnel-router.ts) — `proxyStream` builds the bridge request:

```ts
const request: HttpProxiedRequest = {
  requestId: crypto.randomUUID(),
  instanceId,
  agentName,
  method: "stream",
  body,
  headers,  // ← whatever was passed in; no x-pekohub-user-id added
};
```

The headers passed in are just `{ "content-type": "application/json" }`. PekoHub **never** injects the authenticated user's id into the bridge payload. So the runtime's ACL always sees an empty `x-pekohub-user-id` and denies.

### 2.3 PekoHub's Own Auth Succeeds

PekoHub's chat route at `instances.ts:545-561` validates the JWT (via `fastify.authenticate(request)`) and lets private-instance requests through. PekoHub's *own* auth is fine. The bug is purely in the **bridge payload it sends to the runtime** — the header that the runtime needs to do its own defense-in-depth check.

### 2.4 The Failing Test (in peko-runtime) Probes Exactly This Path

`peko-runtime/tests/tunnel_e2e.rs::test_e2e_tunnel_chat_with_llm` creates a private instance, sends a chat with a valid JWT, and expects an SSE stream with the LLM's response. The test had been failing in CI; earlier failures were gating the build.

The peko-runtime side workaround (in commit `d534abf`) PATCHed the instance to `exposure: "public"` before the chat so the runtime's ACL was bypassed. That tested the public-chat path, not the private-chat-with-auth path the test was designed for. The proper fix was for pekohub to forward the user id, restoring the private-instance path.

---

## 3. Design Goals

1. **Private-instance chat must work** for any user whose JWT verifies and whose id is in the instance's `allowed_users` list (or who is the instance owner).
2. **Runtime ACL must still fire** as defense-in-depth. The runtime's check exists for a reason (the tunnel is a long-lived authenticated connection; per-request re-check keeps the runtime safe if pekohub's auth is misconfigured).
3. **No regression on public instances.** The header injection must not break the existing public-instance path.
4. **Surface the cause** in operator logs when the header is missing (caller misconfiguration vs. a real auth bypass attempt).

---

## 4. Solution

### 4.1 Inject `x-pekohub-user-id` in `proxyStream` / `proxyChat` (single chokepoint)

In `backend/src/services/tunnel-router.ts`, both `proxyChat` and `proxyStream` now take an optional `user?: { id: number } | null` parameter. When present, the user id is merged into the bridge headers:

```ts
const mergedHeaders = user
  ? { ...headers, "x-pekohub-user-id": String(user.id) }
  : headers;
```

This is the single chokepoint where HTTP becomes tunnel protocol. One change covers every caller (chat, stream, public chat, future endpoints).

### 4.2 Pass authenticated user from all call sites

- **`/instances/:id/chat`** — passes `userId !== null ? { id: userId } : null`
- **`/instances/:id/stream`** — passes the same (runtime ACL applies identically to streams)
- **`/public/agents/:owner/:agentName/chat`** — passes `null` (public by design, no auth)

### 4.3 Defensive logging on both sides

**PekoHub side** (`instances.ts`): After `fastify.authenticate()`, if `user.id` is unexpectedly missing, the route logs a warning and returns 500 instead of silently injecting `"undefined"` as the header value.

**Runtime side** (`dispatcher.rs`): Added `warn!` logs when:
- `x-pekohub-user-id` is missing on a private-instance request (pekohub regression)
- The user id is present but not in `allowed_users` (legitimate ACL deny)

---

## 5. Files Modified

| File | Change |
|------|--------|
| `backend/src/services/tunnel-router.ts` | `proxyChat` and `proxyStream` take optional `user`; inject `x-pekohub-user-id` into bridge headers when present |
| `backend/src/routes/api/instances.ts` | All three `proxyStream` call sites pass the authenticated `user` (or `null` for public); defensive guard for missing `user.id` after auth |
| `backend/tests/integration/tunnel-proxy.test.ts` | **NEW** regression test: private-instance chat with valid JWT injects `x-pekohub-user-id` into the bridge payload |
| `peko-runtime/src/tunnel/dispatcher.rs` | `warn!` on missing header and unauthorized user in `check_request_allowed` |
| `peko-runtime/tests/tunnel_e2e.rs` | Removed the `PATCH exposure: "public"` workaround; test now exercises the actual private-chat-with-auth path |

---

## 6. Verification

| Check | Result |
|-------|--------|
| `tsc --noEmit` (pekohub/backend) | ✅ Clean |
| `cargo check` (peko-runtime) | ✅ Clean (only pre-existing warnings) |
| `vitest run` (pekohub/backend) | ✅ 88/88 tests pass |
| New regression test | ✅ Passes — verifies `x-pekohub-user-id` is present in bridge payload for private instances |

---

## 7. Post-Close Notes

- The same fix likely unblocks other private-instance flow features (scheduled jobs, telemetry, etc.) that may not be surfaced in CI today.
- The pekohub issue #001 fix (`nullishToUndefined` for `hooks`) was a similar pattern: an opaque downstream schema assumption that only surfaced when a test exercised the full path.
- `proxyChat` is currently unused (only `proxyStream` is called by the three routes). It was updated for parity and future-proofing; consider deleting it in a follow-up if no new tunnel verbs are planned.
