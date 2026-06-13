# Issue 001: `/v1/search` 500s When Any Item's `hooks` Is Null

**Status:** Open
**Priority:** P2
**Area:** Search API / Bundles Route / Zod Response Schema
**Related:** `backend/src/plugins/search.ts`, `backend/src/routes/api/bundles.ts`, `backend/src/db/schema.ts`, `backend/tests/integration/*` (caller: `peko-runtime/tests/pekohub_integration.rs::test_pekohub_search_api`)

---

## 1. Problem Summary

`GET /v1/search` returns **HTTP 500** with a Zod error whenever a result item's `hooks` field is `null` — even though the field is genuinely optional from the client's perspective (the agent they pushed had no hooks).

Reproduction (from `peko-runtime` integration suite, `test_pekohub_search_api`):
1. Push an OCI manifest whose `dev.pekohub.metadata` annotation is:
   ```json
   {"bundleType":"agent","description":"A searchable test agent","author":"test"}
   ```
   (no `hooks` key)
2. `GET /v1/search?q=searchable`
3. Response:
   ```json
   {
     "statusCode": 500,
     "error": "Internal Server Error",
     "message": "[{\"code\":\"invalid_type\",\"expected\":\"array\",\"received\":\"null\",\"path\":[\"items\",0,\"hooks\"],\"message\":\"Expected array, received null\"}]"
   }
   ```

The test only fails when the **first** hit has `hooks: null` — which is true for any push whose metadata doesn't carry a `hooks` array, i.e. the common case. Manifests that *do* include a `hooks: []` (or a non-empty array) pass.

**Impact:** Any client that searches before at least one indexed bundle has a hooks-shaped array is broken. The search endpoint is the primary discovery surface, so this is functionally a 500 on the happy path for most real-world bundles (which have no hooks yet).

---

## 2. Root Cause Analysis

### 2.1 The `hooks` Field Is Typed as an Array, But Is Nullable

[`backend/src/db/schema.ts`](backend/src/db/schema.ts) declares:
```ts
hooks: jsonb("hooks").$type<
  Array<{ point: string; handler?: string; topicPattern?: string }>
>(),
```

It's typed as `Array<{…}>` — no `| null`, no `| undefined` — so the *static* contract is "this is always an array of hook objects". But there's no DB-level NOT NULL, and nothing in the bundle-ingest path coerces a missing field to `[]`. So a bundle pushed without a `hooks` annotation ends up persisted with `bundle.hooks === null` in the row.

### 2.2 The Bundle Detail Route Coerces `null` → `undefined`, Not `[]`

[`backend/src/routes/api/bundles.ts:85`](backend/src/routes/api/bundles.ts) does:
```ts
hooks: bundle.hooks ?? undefined,
```

`undefined` is the JSON-serialisation convention for "omit the key", so the response shape is `{}` (no `hooks` key at all) for a bundle with no hooks. That's fine for the detail route — the response *schema* (whatever enforces it) must allow the field to be missing.

### 2.3 The Search Response Schema Doesn't Allow It

The search plugin builds search results by mapping bundle rows into a results object. Whatever schema validates that object (Zod via Fastify's response schema, or hand-rolled) is declaring `items[i].hooks: array` — i.e. required-array, not optional. The route emits the row's `hooks` field as `null` (or omits `?? []`), the validator runs, sees `null` where it expected `array`, and 500s with the diagnostic above.

### 2.4 The Failing Test (in peko-runtime) Probes Exactly This Path

`peko-runtime/tests/pekohub_integration.rs::test_pekohub_search_api` pushes a manifest with an OCI top-level `hooks: []` (added explicitly to work around a different latent bug) and a pekohub-metadata annotation without a `hooks` key. PekoHub's ingest path doesn't read the OCI top-level `hooks` field, and the metadata has no `hooks`, so `bundle.hooks === null` in the DB. The test then searches and the response 500s on `items[0].hooks`.

The runtime-side fix in `peko-runtime` (adding `hooks: []` to the metadata JSON) **partially** helps — pekohub may now read it, depending on which path pekohub takes to populate `bundle.hooks`. But the schema bug remains: any caller who doesn't know to set the metadata trick still 500s.

---

## 3. Design Goals

1. **Search must never 500 on a missing-optional field.** `hooks` (and any other optional array) must be representable as `[]` end-to-end when the underlying data has no value.
2. **No schema regressions.** Existing search responses that *do* include a populated `hooks` array must keep working byte-for-byte.
3. **Push path shouldn't need to know the workaround.** A manifest that omits `hooks` from its pekohub metadata should yield a search result with `hooks: []`, not `hooks: null`.
4. **Surface the actual cause in logs.** The current 500 wraps the Zod error as a single string, which is fine for debugging but should also be logged at `error` level so operators can find it without a client trace.

---

## 4. Proposed Solution

### 4.1 Coerce `null` → `[]` at the DB-read boundary (minimal fix)

In [`backend/src/routes/api/bundles.ts:85`](backend/src/routes/api/bundles.ts) and the equivalent site in the search response mapper, change:
```ts
hooks: bundle.hooks ?? undefined,
```
to
```ts
hooks: bundle.hooks ?? [],
```

Same for any other optional-array fields surfaced from the same path (audit the response schema and the bundle-to-result mapper; candidates include `modelProviders`, `requiredMcpServers`, `tags`, `categories` — each has the same `?? undefined` shape).

### 4.2 Relax the response schema (defence in depth)

If a Zod schema is gating the response, change `hooks: z.array(…)` to `hooks: z.array(…).nullable().default([])`, or use `z.preprocess(v => v ?? [], z.array(…))` so even an upstream change that re-introduces `null` won't 500. Same for the other optional arrays.

### 4.3 Optional: backfill at the DB level

If we want the wire shape to match the schema without per-route coercion, add a DB-level default (e.g. `default([])` in the Drizzle schema) so `bundle.hooks` is always an array. Lower priority — option 4.1 alone is sufficient for the search 500.

---

## 5. Implementation Plan

1. **Audit the search response mapper** (`backend/src/plugins/search.ts` and any helpers) for every field that comes from `bundle.hooks`-style nullable JSONB columns. Make a list (at minimum: `hooks`, `modelProviders`, `requiredMcpServers`, `tags`, `categories`, `compatibility`).
2. **Coerce each to `?? []`** where the schema says array.
3. **Update the response Zod schema** to allow `null` (or default to `[]`) for the same fields. This is defence-in-depth so a future contributor who forgets step 2 doesn't 500 every user.
4. **Add a regression test** in `backend/tests/integration/` that:
   - Pushes a bundle **without** a `hooks` annotation.
   - Calls `/v1/search` and asserts HTTP 200 with a result item whose `hooks` is `[]` (not `null`, not missing).
5. **Add a unit test** for the search plugin's response mapper: feed it a bundle row with `hooks: null` and assert the produced response shape has `hooks: []`.
6. **Log the underlying Zod error** at `error` level when a response fails validation, so operators can find the issue without client-side trace dumps.

---

## 6. Key Design Decisions

**Why coerce at the read boundary instead of at the DB write boundary?**
- Read-side coercion is local, reversible, and doesn't touch the ingest path. If a future feature wants to distinguish "no hooks" (empty array) from "hooks explicitly null" (something exotic), the DB still has the truth.
- DB-level backfill would silently mutate user data — anything that introspects the row would see a different shape than what was pushed.

**Why relax the Zod schema in addition to coercing?**
- Coercion alone is correct today. But the schema is the *contract*; if a future refactor forgets the `?? []`, the validator catches it instead of the caller. The two are belt-and-suspenders.
- It also fixes any other endpoints that share the same response shape without each one having to remember the coercion.

**Why not just `.nullable()` everywhere?**
- It would let `null` through to clients, who then have to handle two shapes (`null` vs `[]`) for the same field. Empty-array-on-missing is friendlier and matches OCI convention.

---

## 7. Files to Modify

| File | Change |
|------|--------|
| `backend/src/plugins/search.ts` | Coerce nullable-array fields to `[]` in the response mapper (lines around 146-160) |
| `backend/src/routes/api/bundles.ts` | Coerce `hooks: bundle.hooks ?? []` (line 85); audit other optional-array fields at the same site |
| `backend/src/db/schema.ts` | Optional: add `default([])` to the `hooks` JSONB column (line 107) |
| `backend/src/routes/api/**` (any other route returning a bundle shape) | Apply the same `?? []` coercion |
| `backend/tests/integration/search.test.ts` (or equivalent) | **NEW** regression test: push without `hooks`, search, expect 200 with `hooks: []` |
| `backend/tests/unit/search.test.ts` (or equivalent) | **NEW** unit test: bundle row with `hooks: null` → response with `hooks: []` |

---

## 8. Tasks

- [ ] Audit search response mapper for all nullable-array fields
- [ ] Coerce each to `?? []` in the search response mapper
- [ ] Apply `?? []` coercion in `backend/src/routes/api/bundles.ts` line 85
- [ ] Apply `?? []` coercion in any other route returning the same shape
- [ ] Relax the Zod response schema to allow `null` (or default to `[]`) for the same fields
- [ ] Add integration test: push without `hooks` annotation, expect 200 with `hooks: []`
- [ ] Add unit test for the search response mapper
- [ ] Log Zod response-validation errors at `error` level
- [ ] Confirm `peko-runtime`'s `test_pekohub_search_api` integration test now passes against this build
