# Issue 002: Chat Proxy Drops `x-pekohub-user-id`, Breaking Private-Instance ACL

**Status:** Open
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

`peko-runtime/tests/tunnel_e2e.rs::test_e2e_tunnel_chat_with_llm` creates a private instance, sends a chat with a valid JWT, and expects an SSE stream with the LLM's response. The test has been failing in CI for as long as the runtime's ACL + pekohub's missing-header bug have coexisted; we just hadn't gotten to it because earlier failures were gating the build.

The peko-runtime side fix (in commit `d534abf`) PATCHes the instance to `exposure: "public"` before the chat so the runtime's ACL is bypassed. That works for now but it tests a different scenario than the test was designed for (the public-chat path, not the private-chat-with-auth path). The proper fix is for pekohub to forward the user id, restoring the private-instance path.

---

## 3. Design Goals

1. **Private-instance chat must work** for any user whose JWT verifies and whose id is in the instance's `allowed_users` list (or who is the instance owner).
2. **Runtime ACL must still fire** as defense-in-depth. The runtime's check exists for a reason (the tunnel is a long-lived authenticated connection; per-request re-check keeps the runtime safe if pekohub's auth is misconfigured).
3. **No regression on public instances.** The header injection must not break the existing public-instance path.
4. **Surface the cause** in operator logs when the header is missing (caller misconfiguration vs. a real auth bypass attempt).

---

## 4. Proposed Solution

### 4.1 Inject `x-pekohub-user-id` in `proxyStream` (minimal fix)

In [`backend/src/services/tunnel-router.ts:64-114`](https://github.com/ConekoAI/pekohub/blob/master/backend/src/services/tunnel-router.ts), resolve the user id from the chat request and inject it into the bridge headers before constructing the `HttpProxiedRequest`:

```ts
async proxyStream(
  runtimeId: string,
  instanceId: string,
  agentName: string,
  body: unknown,
  headers: Record<string, string>,
  reply: FastifyReply,
  user?: { id: number } | null,  // ← new optional param
): Promise<void> {
  const mergedHeaders = { ...headers };
  if (user) {
    mergedHeaders["x-pekohub-user-id"] = String(user.id);
  }
  // ... rest of the function uses mergedHeaders instead of headers
}
```

The chat route at `instances.ts:556` already has the authenticated `user` object from `fastify.authenticate(request)`. Pass it into `proxyStream`:

```ts
let userId: number | null = null;
if (instance.exposure === "private" || instance.exposure === "unexposed") {
  try {
    const user = await fastify.authenticate(request);
    userId = user.id;
  } catch {
    return reply.status(401).send({ error: "Authentication required" });
  }
}
// ...
await fastify.tunnelRouter.proxyStream(
  instance.runtimeId, id, instance.name, body.data,
  { "content-type": "application/json" },
  reply,
  userId !== null ? { id: userId } : null,  // ← pass through
);
```

For the *unauthenticated public-instance* path, `user` is `null` and the header is omitted — the runtime's ACL lets it through because exposure is `Public`.

### 4.2 Make the helper aware of "I know who this is"

`proxyStream` is also called from other routes (stream proxy, public chat). Make the `user` parameter optional and only inject the header when provided. Don't change the call sites that don't have a user — they should continue to work as before.

### 4.3 Log when the header is absent on a private instance

Add a structured log in the runtime's ACL when `x-pekohub-user-id` is missing on a private-instance request. PekoHub's chat route should also log a warning if the authenticated `user.id` is unexpectedly not set on the bridge payload after the fix — defensive cross-checking for the next regression.

---

## 5. Implementation Plan

1. **Add `user?: { id: number } | null` parameter to `TunnelRouter.proxyStream`** (default `null`).
2. **In the chat route at `instances.ts:556`**, capture the authenticated `user` (already returned by `fastify.authenticate(request)`) and pass it through to `proxyStream`.
3. **In the stream proxy route at `instances.ts:602`** (and any other `proxyStream` callers), either pass the user through (if there is one) or leave as `null` (the unauthenticated-by-design public cases).
4. **In `proxyStream`**, build `mergedHeaders = { ...headers, "x-pekohub-user-id": String(user.id) }` when `user` is non-null, and use `mergedHeaders` in the bridge request.
5. **Add a regression test** in `backend/tests/integration/` (or extend an existing search/chat test) that:
   - Creates a private instance owned by a test user.
   - Sends a chat with that user's JWT.
   - Asserts the SSE stream returns the LLM response (i.e. the runtime's ACL let it through).
6. **Add a log** in the runtime's `check_request_allowed` when `user_id` is empty for a private instance, so the next regression surfaces immediately.

---

## 6. Key Design Decisions

**Why inject in `proxyStream` rather than in each route?**
- `proxyStream` is the single chokepoint where HTTP becomes tunnel protocol. One change covers every caller (chat, stream, public chat, future endpoints).
- Each route still owns its own auth decision (e.g. private-instance 401 before the proxy); the header injection is purely about *post-auth* identification for the runtime.

**Why an optional parameter rather than always requiring a user?**
- Public/streaming endpoints intentionally accept anonymous requests. Forcing a user parameter would make the type lie.
- A nullable optional makes the call site self-documenting: callers that have authenticated a user pass it; callers that haven't (by design) pass `null`.

**Why use the user id, not a JWT or API-key?**
- The runtime's tunnel protocol is a binary WS, not HTTPS. Forwarding a Bearer token would mean the runtime has to validate JWTs on every chat call — expensive and redundant.
- The id is what the runtime's ACL actually needs (it just compares against `allowed_users`).
- A short-lived, runtime-internal "this is who pekohub authenticated" identifier is the right shape; pekohub is the trust boundary.

**Why log the absence rather than fail loudly?**
- The current behavior is fail-silent (request hangs or returns 200 with an error SSE event). A log entry preserves the existing test surface while making the next regression findable.
- We don't want to make pekohub break the runtime's defense-in-depth model by silently dropping the header; the log makes the contract visible.

---

## 7. Files to Modify

| File | Change |
|------|--------|
| `backend/src/services/tunnel-router.ts` | `proxyStream` takes optional `user`; injects `x-pekohub-user-id` into the bridge headers when present |
| `backend/src/routes/api/instances.ts` | Chat route (`/instances/:id/chat`) passes the authenticated `user` to `proxyStream`; other callers reviewed for the same |
| `backend/tests/integration/` (new or extended) | **NEW** regression test: private-instance chat with a valid JWT returns the LLM response (not "Authentication required") |
| `peko-runtime/src/tunnel/dispatcher.rs` | Optional: add a `warn!` when `x-pekohub-user-id` is missing on a private-instance request, so pekohub-side regressions surface in peko-runtime logs |

---

## 8. Tasks

- [ ] Add `user?: { id: number } | null` parameter to `TunnelRouter.proxyStream`
- [ ] In `proxyStream`, merge `x-pekohub-user-id: String(user.id)` into `headers` when `user` is non-null
- [ ] In the chat route at `instances.ts:545`, pass the authenticated `user` object to `proxyStream`
- [ ] Audit other `proxyStream` callers (`/instances/:id/stream`, `/public/agents/:owner/:agentName/chat`) and decide whether they need a user too (most should pass `null`; stream proxy may need the same treatment if the runtime ACL applies to streams)
- [ ] Add integration test: private-instance chat with valid JWT returns the LLM response
- [ ] Add `warn!` in `peko-runtime/src/tunnel/dispatcher.rs::check_request_allowed` for the missing-header case (defensive)
- [ ] Confirm `peko-runtime`'s `test_e2e_tunnel_chat_with_llm` integration test passes against this build *and* remove the public-exposure workaround from `tunnel_e2e.rs`

---

## 9. Post-Close Notes

- The same fix likely unblocks other private-instance flow features (scheduled jobs, telemetry, etc.) that may not be surfaced in CI today.
- The pekohub issue #001 fix (`nullishToUndefined` for `hooks`) was a similar pattern: an opaque downstream schema assumption that only surfaced when a test exercised the full path.
