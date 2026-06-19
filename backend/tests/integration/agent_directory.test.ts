import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createTestDb, resetTables } from "../fixtures/db.js";
import { buildTestApp } from "../fixtures/app.js";
import { createUser, createInstance } from "../fixtures/factories.js";
import { authHeaders } from "../fixtures/auth.js";
import type { TestDb } from "../fixtures/db.js";

// ─────────────────────────────────────────────────────────────────────────────
// Agent directory API (issue #14).
//
// Pinned to the acceptance criteria from the issue:
//
//   - hit  → 200 with `{ runtime_id, instance_id, agent_did,
//                          owner_principal, exposure }`
//   - miss → 404
//   - denied → 403 (NOT 404, so the existence-vs-permission
//     distinction is preserved for legitimate callers)
//
// Both endpoints are tested with: hit, miss, denied, public exposure
// (anonymous-OK). The by-handle endpoint is the v1 user-namespace-only
// surface; team-handle resolution is a follow-up gated on pekohub#8.
// ─────────────────────────────────────────────────────────────────────────────

describe("Agent directory API", () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  });

  beforeEach(async () => {
    await resetTables(testDb.client);
  });

  afterAll(async () => {
    await testDb.client.close();
  });

  const REAL_DID = "did:peko:agent:abc123def456";

  describe("GET /v1/agents/by-did/:did", () => {
    it("returns 200 with the resolution on a hit (owner is the caller)", async () => {
      const app = await buildTestApp({ testDb });
      const owner = await createUser(testDb.client, { namespace: "alice" });
      const headers = await authHeaders(owner);

      const instance = await createInstance(testDb.client, {
        ownerId: owner.id,
        ownerPrincipal: { kind: "user", id: String(owner.id) },
        name: "helper",
        exposure: "private",
        agentDid: REAL_DID,
      });

      const response = await app.inject({
        method: "GET",
        url: `/v1/agents/by-did/${encodeURIComponent(REAL_DID)}`,
        headers,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body).toEqual({
        runtimeId: instance.runtimeId,
        instanceId: instance.id,
        agentDid: REAL_DID,
        ownerPrincipal: { kind: "user", id: String(owner.id) },
        exposure: "private",
      });
    });

    it("returns 404 on a miss (no row matches the DID)", async () => {
      const app = await buildTestApp({ testDb });
      const owner = await createUser(testDb.client, { namespace: "alice" });
      const headers = await authHeaders(owner);

      const response = await app.inject({
        method: "GET",
        url: `/v1/agents/by-did/${encodeURIComponent(REAL_DID)}`,
        headers,
      });

      expect(response.statusCode).toBe(404);
    });

    it("returns 403 on a denied caller (existence vs permission is preserved)", async () => {
      const app = await buildTestApp({ testDb });
      const owner = await createUser(testDb.client, { namespace: "alice" });
      const other = await createUser(testDb.client, { namespace: "bob" });
      const otherHeaders = await authHeaders(other);

      // A private agent owned by alice — bob must not see it.
      await createInstance(testDb.client, {
        ownerId: owner.id,
        ownerPrincipal: { kind: "user", id: String(owner.id) },
        name: "secret",
        exposure: "private",
        agentDid: REAL_DID,
      });

      const response = await app.inject({
        method: "GET",
        url: `/v1/agents/by-did/${encodeURIComponent(REAL_DID)}`,
        headers: otherHeaders,
      });

      expect(response.statusCode).toBe(403);
    });

    it("returns 200 on a public agent for any caller (exposure short-circuits)", async () => {
      const app = await buildTestApp({ testDb });
      const owner = await createUser(testDb.client, { namespace: "alice" });
      const headers = await authHeaders(owner);

      await createInstance(testDb.client, {
        ownerId: owner.id,
        ownerPrincipal: { kind: "user", id: String(owner.id) },
        name: "public-agent",
        exposure: "public",
        agentDid: REAL_DID,
      });

      const response = await app.inject({
        method: "GET",
        url: `/v1/agents/by-did/${encodeURIComponent(REAL_DID)}`,
        headers,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.exposure).toBe("public");
      expect(body.agentDid).toBe(REAL_DID);
    });

    it("returns 200 on a public agent for an anonymous caller", async () => {
      const app = await buildTestApp({ testDb });
      const owner = await createUser(testDb.client, { namespace: "alice" });

      await createInstance(testDb.client, {
        ownerId: owner.id,
        ownerPrincipal: { kind: "user", id: String(owner.id) },
        name: "public-agent",
        exposure: "public",
        agentDid: REAL_DID,
      });

      const response = await app.inject({
        method: "GET",
        url: `/v1/agents/by-did/${encodeURIComponent(REAL_DID)}`,
      });

      expect(response.statusCode).toBe(200);
    });

    it("returns 400 when the path segment is not a DID", async () => {
      const app = await buildTestApp({ testDb });
      const owner = await createUser(testDb.client, { namespace: "alice" });
      const headers = await authHeaders(owner);

      const response = await app.inject({
        method: "GET",
        url: "/v1/agents/by-did/not-a-did",
        headers,
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe("GET /v1/agents/by-handle/:owner/:agent_name", () => {
    it("returns 200 with the resolution on a hit", async () => {
      const app = await buildTestApp({ testDb });
      const owner = await createUser(testDb.client, { namespace: "alice" });
      const headers = await authHeaders(owner);

      const instance = await createInstance(testDb.client, {
        ownerId: owner.id,
        ownerPrincipal: { kind: "user", id: String(owner.id) },
        name: "helper",
        exposure: "private",
        agentDid: REAL_DID,
      });

      const response = await app.inject({
        method: "GET",
        url: "/v1/agents/by-handle/alice/helper",
        headers,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body).toEqual({
        runtimeId: instance.runtimeId,
        instanceId: instance.id,
        agentDid: REAL_DID,
        ownerPrincipal: { kind: "user", id: String(owner.id) },
        exposure: "private",
      });
    });

    it("returns 404 when the owner namespace does not exist", async () => {
      const app = await buildTestApp({ testDb });
      const caller = await createUser(testDb.client, { namespace: "bob" });
      const headers = await authHeaders(caller);

      const response = await app.inject({
        method: "GET",
        url: "/v1/agents/by-handle/alice/helper",
        headers,
      });

      expect(response.statusCode).toBe(404);
    });

    it("returns 404 when the owner exists but the agent name doesn't", async () => {
      const app = await buildTestApp({ testDb });
      const owner = await createUser(testDb.client, { namespace: "alice" });
      const headers = await authHeaders(owner);

      // Owner exists, but no instance with that name.
      await createInstance(testDb.client, {
        ownerId: owner.id,
        ownerPrincipal: { kind: "user", id: String(owner.id) },
        name: "different-name",
      });

      const response = await app.inject({
        method: "GET",
        url: "/v1/agents/by-handle/alice/helper",
        headers,
      });

      expect(response.statusCode).toBe(404);
    });

    it("returns 403 on a denied caller", async () => {
      const app = await buildTestApp({ testDb });
      const owner = await createUser(testDb.client, { namespace: "alice" });
      const other = await createUser(testDb.client, { namespace: "bob" });
      const otherHeaders = await authHeaders(other);

      await createInstance(testDb.client, {
        ownerId: owner.id,
        ownerPrincipal: { kind: "user", id: String(owner.id) },
        name: "secret",
        exposure: "private",
      });

      const response = await app.inject({
        method: "GET",
        url: "/v1/agents/by-handle/alice/secret",
        headers: otherHeaders,
      });

      expect(response.statusCode).toBe(403);
    });
  });
});
