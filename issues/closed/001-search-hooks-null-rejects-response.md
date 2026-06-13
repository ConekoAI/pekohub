# Issue 001: `/v1/search` 500s When Any Item's `hooks` Is Null

**Status:** Closed (resolved 2026-06-13)  
**Priority:** P2  
**Area:** Search API / Bundles Route / Zod Response Schema  
**Related:** `backend/src/plugins/search.ts`, `backend/src/routes/api/bundles.ts`, `backend/src/routes/api/search.ts`, `backend/src/routes/oci/manifests.ts`, `packages/shared/src/schemas.ts`, `backend/tests/integration/search.test.ts`, `packages/shared/src/schemas.test.ts` (caller: `peko-runtime/tests/pekohub_integration.rs::test_pekohub_search_api`)

---

## 1. Problem Summary

`GET /v1/search` returned **HTTP 500** with a Zod error whenever a result item's `hooks` field was `null` — even though the field was genuinely optional from the client's perspective (the agent they pushed had no hooks).

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

The test only failed when the **first** hit had `hooks: null` — which was true for any push whose metadata didn't carry a `hooks` array, i.e. the common case. Manifests that *did* include a `hooks: []` (or a non-empty array) passed.

**Impact:** Any client that searched before at least one indexed bundle had a hooks-shaped array was broken. The search endpoint was the primary discovery surface, so this was functionally a 500 on the happy path for most real-world bundles (which have no hooks yet).

---

## 2. Root Cause Analysis

### 2.1 The `hooks` Field Is Typed as an Array, But Is Nullable

[`backend/src/db/schema.ts`](backend/src/db/schema.ts) declares:
```ts
hooks: jsonb("hooks").$type<
  Array<{ point: string; handler?: string; topicPattern?: string }>
>(),
```

It's typed as `Array<{…}>` — no `| null`, no `| undefined` — so the *static* contract is "this is always an array of hook objects". But there's no DB-level NOT NULL, and nothing in the bundle-ingest path coerced a missing field to `[]`. So a bundle pushed without a `hooks` annotation ended up persisted with `bundle.hooks === null` in the row.

### 2.2 The Bundle Detail Route Coerces `null` → `undefined`, Not `[]`

[`backend/src/routes/api/bundles.ts:85`](backend/src/routes/api/bundles.ts) does:
```ts
hooks: bundle.hooks ?? undefined,
```

`undefined` is the JSON-serialisation convention for "omit the key", so the response shape is `{}` (no `hooks` key at all) for a bundle with no hooks. That's fine for the detail route — the response *schema* (whatever enforces it) must allow the field to be missing.

### 2.3 The Search Response Schema Didn't Allow `null`

The search plugin built search results by mapping bundle rows into a results object. The Zod schema validating that object declared `items[i].hooks: array` — i.e. required-array, not optional. The route emitted the row's `hooks` field as `null`, the validator ran, saw `null` where it expected `array`, and 500ed with the diagnostic above.

### 2.4 The Failing Test (in peko-runtime) Probed Exactly This Path

`peko-runtime/tests/pekohub_integration.rs::test_pekohub_search_api` pushed a manifest with an OCI top-level `hooks: []` (added explicitly to work around a different latent bug) and a pekohub-metadata annotation without a `hooks` key. PekoHub's ingest path didn't read the OCI top-level `hooks` field, and the metadata had no `hooks`, so `bundle.hooks === null` in the DB. The test then searched and the response 500ed on `items[0].hooks`.

The runtime-side fix in `peko-runtime` (adding `hooks: []` to the metadata JSON) **partially** helped — pekohub may now read it, depending on which path pekohub takes to populate `bundle.hooks`. But the schema bug remained: any caller who didn't know to set the metadata trick still 500ed.

---

## 3. Design Goals

1. **Search must never 500 on a missing-optional field.** `hooks` (and any other optional array) must be representable end-to-end when the underlying data has no value.
2. **No schema regressions.** Existing search responses that *do* include a populated `hooks` array must keep working byte-for-byte.
3. **Push path shouldn't need to know the workaround.** A manifest that omits `hooks` from its pekohub metadata should yield a valid search result, not a 500.
4. **Surface the actual cause in logs.** The 500 wraps the Zod error as a single string, which is fine for debugging but should also be logged at `error` level so operators can find it without a client trace.

### 3.1 Chosen Wire Shape: `undefined` (key omitted), not `[]`

After review, the implementation chose to coerce `null` → `undefined` at the Zod schema boundary rather than `null` → `[]`. This means:
- A bundle with no hooks produces a response **without** a `hooks` key (same as the bundle detail route's existing behaviour).
- A bundle with hooks produces a response **with** a `hooks` array.
- Clients see a single shape (`Array<Hook>`) when present, and absence when not — no need to handle `[]` vs `null` vs missing.

This aligns with the existing `bundle.detail` route convention (`hooks: bundle.hooks ?? undefined`) and avoids forcing clients to check `.length === 0` to detect "no hooks".

---

## 4. Solution Implemented

### 4.1 Schema-level defence in depth (`packages/shared/src/schemas.ts`)

Added a reusable `nullishToUndefined` helper that coerces `null` → `undefined` via `z.preprocess`:

```ts
const nullishToUndefined = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((val) => (val === null ? undefined : val), schema);
```

Applied to all optional array fields in `BundleMetadata` and `SearchResultItem`:
- `tags`
- `categories`
- `modelProviders`
- `requiredMcpServers`
- `hooks`

This makes the schema self-healing: any Meilisearch document (or DB row) that still carries `null` for these fields will validate successfully, with the field treated as absent.

### 4.2 Index-time sanitization (`backend/src/plugins/search.ts`)

Updated `indexBundle` to destructure `hooks` explicitly and only include it in the indexed document when non-null:

```ts
const { objectID, compatibility, hooks, ...rest } = doc;
const sanitizedDoc: Record<string, unknown> = {
  ...rest,
  id: sanitizeObjectID(objectID),
  hookPoints: hooks?.map((h) => h.point) ?? [],
};
if (hooks != null) {
  sanitizedDoc.hooks = hooks;
}
```

This prevents Meilisearch from ever storing `null` for `hooks` going forward.

### 4.3 Ingest-path normalisation (`backend/src/routes/oci/manifests.ts`)

Changed the `indexBundle` call from:
```ts
hooks: bundle.hooks as Array<...> | undefined,
```
to:
```ts
hooks: bundle.hooks ?? undefined,
```

This ensures `null` is converted to `undefined` before passing to the search service.

### 4.4 Response-validation error logging (`backend/src/routes/api/search.ts`)

Changed from `SearchResponse.parse()` (which throws on failure) to `SearchResponse.safeParse()` with explicit error logging:

```ts
const parseResponse = SearchResponse.safeParse({ ... });
if (!parseResponse.success) {
  fastify.log.error(
    { zodError: parseResponse.error.flatten() },
    "Search response failed Zod validation"
  );
  return reply.status(500).send({
    statusCode: 500,
    error: "Internal Server Error",
    message: parseResponse.error.message,
  });
}
```

Operators now see a structured error log entry with the full Zod flatten output, rather than having to rely on a client-side trace dump.

---

## 5. Tests Added

| File | What it covers |
|------|----------------|
| `packages/shared/src/schemas.test.ts` | 13 unit tests: `null` → `undefined` coercion for `SearchResultItem`, `SearchResponse`, and `BundleMetadata`; verifies non-null arrays are preserved; verifies invalid types are still rejected. |
| `backend/tests/integration/search.test.ts` | 2 integration tests: (1) search with `hooks: null` in Meilisearch returns 200 with `hooks` omitted; (2) search with non-empty `hooks` array preserves the array in the response. |

All tests pass:
- Shared package: 26 tests (13 source + 13 compiled)
- Backend: 87 tests (all existing + 2 new search integration tests)

---

## 6. Key Design Decisions

**Why coerce `null` → `undefined` at the schema boundary instead of `null` → `[]`?**
- It matches the existing bundle detail route convention (`hooks: bundle.hooks ?? undefined`).
- It avoids forcing clients to distinguish `[]` from missing — absence is the natural "not present" signal.
- The schema is the single source of truth; all routes and consumers get the fix automatically.

**Why relax the Zod schema in addition to sanitising at index time?**
- Index-time sanitisation prevents new `null` values from entering Meilisearch.
- Schema relaxation protects against any other source of `null` (legacy documents, manual index edits, future bugs).
- The two are belt-and-suspenders.

**Why not `.nullable()` everywhere?**
- It would let `null` through to clients, who then have to handle two shapes (`null` vs `[]` vs missing) for the same field. `undefined` (omitted key) is friendlier and matches existing API conventions.

---

## 7. Files Modified

| File | Change |
|------|--------|
| `packages/shared/src/schemas.ts` | Added `nullishToUndefined` helper; applied to `tags`, `categories`, `modelProviders`, `requiredMcpServers`, `hooks` in `BundleMetadata` and `SearchResultItem` |
| `backend/src/plugins/search.ts` | `indexBundle` now destructures `hooks` and only includes it when non-null |
| `backend/src/routes/oci/manifests.ts` | `hooks: bundle.hooks ?? undefined` instead of type-cast |
| `backend/src/routes/api/search.ts` | Switched to `SearchResponse.safeParse()` with `fastify.log.error` on validation failure |
| `packages/shared/src/schemas.test.ts` | **NEW** — 13 unit tests for null-coercion behaviour |
| `backend/tests/integration/search.test.ts` | **NEW** — 2 integration tests for search with null/missing hooks |

---

## 8. Tasks

- [x] Audit search response mapper for all nullable-array fields
- [x] Coerce each via `nullishToUndefined` in the shared Zod schema
- [x] Apply `?? undefined` coercion in `backend/src/routes/oci/manifests.ts`
- [x] Sanitise `hooks` at index time in `backend/src/plugins/search.ts`
- [x] Relax the Zod response schema to allow `null` (coerced to `undefined`) for the same fields
- [x] Add integration test: push without `hooks` annotation, expect 200 with `hooks` omitted
- [x] Add unit test for the shared schema's null-coercion behaviour
- [x] Log Zod response-validation errors at `error` level
- [x] Confirm `peko-runtime`'s `test_pekohub_search_api` integration test now passes against this build

---

## 9. Post-Close Notes

- The `nullishToUndefined` helper in `@pekohub/shared` can be reused for any future optional array fields that may be stored as JSONB null.
- If a future feature genuinely needs to distinguish "no hooks" from "hooks not queried", the DB still stores the raw `null` — the schema coercion is a read-boundary transform only.
