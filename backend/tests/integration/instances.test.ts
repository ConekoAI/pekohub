import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createTestDb, resetTables } from "../fixtures/db.js";
import { buildTestApp } from "../fixtures/app.js";
import { createUser, createInstance } from "../fixtures/factories.js";
import { authHeaders } from "../fixtures/auth.js";
import type { TestDb } from "../fixtures/db.js";

describe("Instance API", () => {
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

  describe("GET /v1/instances", () => {
    it("should list instances owned by the authenticated user", async () => {
      const app = await buildTestApp({ testDb });
      const user = await createUser(testDb.client, { namespace: "alice" });
      const headers = await authHeaders(user);

      await createInstance(testDb.client, {
        ownerId: user.id,
        name: "agent-1",
        type: "principal",
      });
      await createInstance(testDb.client, {
        ownerId: user.id,
        name: "agent-2",
        type: "principal",
      });

      const response = await app.inject({
        method: "GET",
        url: "/v1/instances",
        headers,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.data).toHaveLength(2);
      expect(body.total).toBe(2);
    });

    it("should filter by status", async () => {
      const app = await buildTestApp({ testDb });
      const user = await createUser(testDb.client, { namespace: "alice" });
      const headers = await authHeaders(user);

      await createInstance(testDb.client, {
        ownerId: user.id,
        name: "online-agent",
        status: "online",
      });
      await createInstance(testDb.client, {
        ownerId: user.id,
        name: "offline-agent",
        status: "offline",
      });

      const response = await app.inject({
        method: "GET",
        url: "/v1/instances?status=online",
        headers,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].name).toBe("online-agent");
    });

    it("should return 401 when not authenticated", async () => {
      const app = await buildTestApp({ testDb });
      const response = await app.inject({
        method: "GET",
        url: "/v1/instances",
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe("GET /v1/instances/:id", () => {
    it("should return instance details for owner", async () => {
      const app = await buildTestApp({ testDb });
      const user = await createUser(testDb.client, { namespace: "alice" });
      const headers = await authHeaders(user);
      const instance = await createInstance(testDb.client, {
        ownerId: user.id,
        name: "my-agent",
      });

      const response = await app.inject({
        method: "GET",
        url: `/v1/instances/${instance.id}`,
        headers,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.name).toBe("my-agent");
    });

    it("should return 404 for non-existent instance", async () => {
      const app = await buildTestApp({ testDb });
      const user = await createUser(testDb.client, { namespace: "alice" });
      const headers = await authHeaders(user);

      const response = await app.inject({
        method: "GET",
        url: "/v1/instances/00000000-0000-0000-0000-000000000000",
        headers,
      });

      expect(response.statusCode).toBe(404);
    });

    it("should allow access to public instance without auth and redact sensitive fields", async () => {
      const app = await buildTestApp({ testDb });
      const user = await createUser(testDb.client, { namespace: "alice" });
      const instance = await createInstance(testDb.client, {
        ownerId: user.id,
        name: "public-agent",
        exposure: "public",
        allowedPrincipals: [{ kind: "user", id: "999" }],
        runtimeId: "runtime-secret",
      });

      const response = await app.inject({
        method: "GET",
        url: `/v1/instances/${instance.id}`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.name).toBe("public-agent");
      expect(body.allowedPrincipals).toBeUndefined();
      expect(body.runtimeId).toBeUndefined();
    });

    it("should return full record including allowedPrincipals and runtimeId for owner", async () => {
      const app = await buildTestApp({ testDb });
      const user = await createUser(testDb.client, { namespace: "alice" });
      const headers = await authHeaders(user);
      const instance = await createInstance(testDb.client, {
        ownerId: user.id,
        name: "public-agent",
        exposure: "public",
        allowedPrincipals: [{ kind: "user", id: String(user.id) }],
        runtimeId: "runtime-secret",
      });

      const response = await app.inject({
        method: "GET",
        url: `/v1/instances/${instance.id}`,
        headers,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.name).toBe("public-agent");
      expect(body.allowedPrincipals).toEqual([{ kind: "user", id: String(user.id) }]);
      expect(body.runtimeId).toBe("runtime-secret");
    });

    it("should redact allowedPrincipals and runtimeId for authenticated non-owner", async () => {
      const app = await buildTestApp({ testDb });
      const owner = await createUser(testDb.client, { namespace: "alice" });
      const viewer = await createUser(testDb.client, { namespace: "bob" });
      const headers = await authHeaders(viewer);
      const instance = await createInstance(testDb.client, {
        ownerId: owner.id,
        name: "public-agent",
        exposure: "public",
        allowedPrincipals: [{ kind: "user", id: String(viewer.id) }],
        runtimeId: "runtime-secret",
      });

      const response = await app.inject({
        method: "GET",
        url: `/v1/instances/${instance.id}`,
        headers,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.allowedPrincipals).toBeUndefined();
      expect(body.runtimeId).toBeUndefined();
    });

    // Issue #11: the new typed columns (`owner_subject`,
    // `allowed_principals`) are also sensitive — they leak the owner's
    // identity and the allow-list. They join the redaction list for
    // non-owners.
    it("should redact ownerSubject and allowedPrincipals for non-owner", async () => {
      const app = await buildTestApp({ testDb });
      const owner = await createUser(testDb.client, { namespace: "alice" });
      const viewer = await createUser(testDb.client, { namespace: "bob" });
      const headers = await authHeaders(viewer);
      const instance = await createInstance(testDb.client, {
        ownerId: owner.id,
        name: "typed-agent",
        exposure: "public",
        ownerSubject: { kind: "principal", id: "helper" },
        allowedPrincipals: [{ kind: "principal", id: "helper" }],
      });

      const response = await app.inject({
        method: "GET",
        url: `/v1/instances/${instance.id}`,
        headers,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.ownerSubject).toBeUndefined();
      expect(body.allowedPrincipals).toBeUndefined();
    });

    it("should return ownerSubject and allowedPrincipals for the owner", async () => {
      const app = await buildTestApp({ testDb });
      const owner = await createUser(testDb.client, { namespace: "alice" });
      const headers = await authHeaders(owner);
      const instance = await createInstance(testDb.client, {
        ownerId: owner.id,
        // Typed owner matches the legacy `ownerId` — the user that
        // registered the row is the resolved owner.
        ownerSubject: { kind: "user", id: String(owner.id) },
        name: "owner-view",
        exposure: "private",
        allowedPrincipals: [{ kind: "user", id: String(owner.id) }],
      });

      const response = await app.inject({
        method: "GET",
        url: `/v1/instances/${instance.id}`,
        headers,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.ownerSubject).toEqual({
        kind: "user",
        id: String(owner.id),
      });
      expect(body.allowedPrincipals).toEqual([
        { kind: "user", id: String(owner.id) },
      ]);
    });

    it("should deny access to private instance without auth", async () => {
      const app = await buildTestApp({ testDb });
      const user = await createUser(testDb.client, { namespace: "alice" });
      const instance = await createInstance(testDb.client, {
        ownerId: user.id,
        name: "private-agent",
        exposure: "private",
      });

      const response = await app.inject({
        method: "GET",
        url: `/v1/instances/${instance.id}`,
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe("POST /v1/instances", () => {
    it("should create a new instance", async () => {
      const app = await buildTestApp({ testDb });
      const user = await createUser(testDb.client, { namespace: "alice" });
      const headers = await authHeaders(user);

      const response = await app.inject({
        method: "POST",
        url: "/v1/instances",
        headers,
        payload: {
          type: "principal",
          name: "new-agent",
          runtime_id: "runtime-abc",
          exposure: "public",
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.payload);
      expect(body.name).toBe("new-agent");
      expect(body.type).toBe("principal");
      expect(body.runtimeId).toBe("runtime-abc");
      expect(body.exposure).toBe("public");
    });

    it("should return 401 when not authenticated", async () => {
      const app = await buildTestApp({ testDb });
      const response = await app.inject({
        method: "POST",
        url: "/v1/instances",
        payload: {
          type: "principal",
          name: "new-agent",
          runtime_id: "runtime-abc",
        },
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe("PATCH /v1/instances/:id", () => {
    it("should update instance fields", async () => {
      const app = await buildTestApp({ testDb });
      const user = await createUser(testDb.client, { namespace: "alice" });
      const headers = await authHeaders(user);
      const instance = await createInstance(testDb.client, {
        ownerId: user.id,
        name: "old-name",
      });

      const response = await app.inject({
        method: "PATCH",
        url: `/v1/instances/${instance.id}`,
        headers,
        payload: { name: "new-name", exposure: "public" },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.name).toBe("new-name");
      expect(body.exposure).toBe("public");
    });

    it("should return 403 for non-owner", async () => {
      const app = await buildTestApp({ testDb });
      const owner = await createUser(testDb.client, { namespace: "alice" });
      const other = await createUser(testDb.client, { namespace: "bob" });
      const headers = await authHeaders(other);
      const instance = await createInstance(testDb.client, {
        ownerId: owner.id,
        name: "my-agent",
      });

      const response = await app.inject({
        method: "PATCH",
        url: `/v1/instances/${instance.id}`,
        headers,
        payload: { name: "hacked" },
      });

      expect(response.statusCode).toBe(403);
    });
  });

  describe("DELETE /v1/instances/:id", () => {
    it("should delete an instance when authenticated as owner", async () => {
      const app = await buildTestApp({ testDb });
      const user = await createUser(testDb.client, { namespace: "alice" });
      const headers = await authHeaders(user);
      const instance = await createInstance(testDb.client, {
        ownerId: user.id,
        name: "to-delete",
      });

      const response = await app.inject({
        method: "DELETE",
        url: `/v1/instances/${instance.id}`,
        headers,
      });

      expect(response.statusCode).toBe(204);

      const getResponse = await app.inject({
        method: "GET",
        url: `/v1/instances/${instance.id}`,
        headers,
      });
      expect(getResponse.statusCode).toBe(404);
    });

    it("should return 403 for non-owner", async () => {
      const app = await buildTestApp({ testDb });
      const owner = await createUser(testDb.client, { namespace: "alice" });
      const other = await createUser(testDb.client, { namespace: "bob" });
      const headers = await authHeaders(other);
      const instance = await createInstance(testDb.client, {
        ownerId: owner.id,
        name: "my-agent",
      });

      const response = await app.inject({
        method: "DELETE",
        url: `/v1/instances/${instance.id}`,
        headers,
      });

      expect(response.statusCode).toBe(403);
    });
  });

  describe("GET /v1/instances/public", () => {
    it("should list public instances without auth", async () => {
      const app = await buildTestApp({ testDb });
      const user = await createUser(testDb.client, { namespace: "alice" });

      await createInstance(testDb.client, {
        ownerId: user.id,
        name: "public-1",
        exposure: "public",
        status: "online",
      });
      await createInstance(testDb.client, {
        ownerId: user.id,
        name: "private-1",
        exposure: "private",
        status: "online",
      });

      const response = await app.inject({
        method: "GET",
        url: "/v1/instances/public",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].name).toBe("public-1");
    });
  });

  describe("POST /v1/instances/:id/chat", () => {
    it("should return 404 for non-existent instance", async () => {
      const app = await buildTestApp({ testDb });
      const response = await app.inject({
        method: "POST",
        url: "/v1/instances/00000000-0000-0000-0000-000000000000/chat",
        payload: { message: "hello" },
      });
      expect(response.statusCode).toBe(404);
    });

    it("should require auth for private instance", async () => {
      const app = await buildTestApp({ testDb });
      const user = await createUser(testDb.client, { namespace: "alice" });
      const instance = await createInstance(testDb.client, {
        ownerId: user.id,
        name: "private-agent",
        exposure: "private",
      });

      const response = await app.inject({
        method: "POST",
        url: `/v1/instances/${instance.id}/chat`,
        payload: { message: "hello" },
      });

      expect(response.statusCode).toBe(401);
    });

    // Review #12 P1: the inbound `x-pekohub-caller-principal` header
    // is no longer trusted without an independent JWT/API-key auth
    // proof. A bare header claim must NOT bypass the chat auth gate.
    it("rejects a private-instance chat with a bare x-pekohub-caller-principal header (no JWT)", async () => {
      const app = await buildTestApp({ testDb });
      const owner = await createUser(testDb.client, { namespace: "alice" });
      const instance = await createInstance(testDb.client, {
        ownerId: owner.id,
        name: "private-agent",
        exposure: "private",
      });

      const response = await app.inject({
        method: "POST",
        url: `/v1/instances/${instance.id}/chat`,
        headers: {
          // Header claims to be the owner — but no JWT. The fix
          // requires JWT first; the header is never honoured in
          // isolation. Pre-fix, this would have been accepted as
          // `Principal::User("<owner.id>")` and proxied through.
          "x-pekohub-caller-principal": `user:${owner.id}`,
        },
        payload: { message: "hello" },
      });

      expect(response.statusCode).toBe(401);
    });

    it("should allow chat to public instance without auth", async () => {
      const app = await buildTestApp({ testDb });
      const user = await createUser(testDb.client, { namespace: "alice" });
      const instance = await createInstance(testDb.client, {
        ownerId: user.id,
        name: "public-agent",
        exposure: "public",
        status: "online",
      });

      const response = await app.inject({
        method: "POST",
        url: `/v1/instances/${instance.id}/chat`,
        payload: { message: "hello" },
      });

      // Will 502 because no tunnel, but should pass auth/exposure/status checks
      expect(response.statusCode).toBe(502);
    }, 35000);

    it("should require ToS acknowledgment when tos_required is true", async () => {
      const app = await buildTestApp({ testDb });
      const user = await createUser(testDb.client, { namespace: "alice" });
      const instance = await createInstance(testDb.client, {
        ownerId: user.id,
        name: "tos-agent",
        exposure: "public",
        status: "online",
        tosRequired: true,
        tosText: "Please agree to our terms.",
      });

      const response = await app.inject({
        method: "POST",
        url: `/v1/instances/${instance.id}/chat`,
        payload: { message: "hello" },
      });

      expect(response.statusCode).toBe(428);
      const body = JSON.parse(response.payload);
      expect(body.error).toBe("Terms of Service acknowledgment required");
      expect(body.tosText).toBe("Please agree to our terms.");
    });
  });

  describe("PATCH /v1/instances/:id/exposure", () => {
    it("should update exposure to public with public profile", async () => {
      const app = await buildTestApp({ testDb });
      const user = await createUser(testDb.client, { namespace: "alice" });
      const headers = await authHeaders(user);
      const instance = await createInstance(testDb.client, {
        ownerId: user.id,
        name: "my-agent",
      });

      const response = await app.inject({
        method: "PATCH",
        url: `/v1/instances/${instance.id}/exposure`,
        headers,
        payload: {
          exposure: "public",
          public_profile: {
            public_name: "My Public Agent",
            description: "A helpful agent",
            tags: ["ai", "productivity"],
            category: "productivity",
            tos_required: true,
            tos_text: "Agree to terms",
            daily_quota: 100,
            weekly_quota: 500,
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.instance.exposure).toBe("public");
      expect(body.instance.publicName).toBe("My Public Agent");
      expect(body.instance.description).toBe("A helpful agent");
      expect(body.instance.tags).toEqual(["ai", "productivity"]);
      expect(body.instance.category).toBe("productivity");
      expect(body.instance.tosRequired).toBe(true);
      expect(body.instance.dailyQuota).toBe(100);
      expect(body.instance.weeklyQuota).toBe(500);
      expect(body.instance.publishedAt).toBeDefined();
    });

    it("should reject invalid exposure transition", async () => {
      const app = await buildTestApp({ testDb });
      const user = await createUser(testDb.client, { namespace: "alice" });
      const headers = await authHeaders(user);
      const instance = await createInstance(testDb.client, {
        ownerId: user.id,
        name: "my-agent",
        exposure: "public",
      });

      const response = await app.inject({
        method: "PATCH",
        url: `/v1/instances/${instance.id}/exposure`,
        headers,
        payload: { exposure: "public" },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect(body.error).toContain("Invalid exposure transition");
    });

    it("should return 403 for non-owner", async () => {
      const app = await buildTestApp({ testDb });
      const owner = await createUser(testDb.client, { namespace: "alice" });
      const other = await createUser(testDb.client, { namespace: "bob" });
      const headers = await authHeaders(other);
      const instance = await createInstance(testDb.client, {
        ownerId: owner.id,
        name: "my-agent",
      });

      const response = await app.inject({
        method: "PATCH",
        url: `/v1/instances/${instance.id}/exposure`,
        headers,
        payload: {
          exposure: "public",
          public_profile: {
            public_name: "X",
            description: "Y",
            tags: [],
            category: "other",
          },
        },
      });

      expect(response.statusCode).toBe(403);
    });
  });

  describe("GET /v1/me/accessible-principals", () => {
    it("should list private principals accessible to the user", async () => {
      const app = await buildTestApp({ testDb });
      const owner = await createUser(testDb.client, { namespace: "alice" });
      const viewer = await createUser(testDb.client, { namespace: "bob" });
      const headers = await authHeaders(viewer);

      await createInstance(testDb.client, {
        ownerId: owner.id,
        name: "shared-principal",
        exposure: "private",
        allowedPrincipals: [{ kind: "user", id: String(viewer.id) }],
        status: "online",
      });

      const response = await app.inject({
        method: "GET",
        url: "/v1/me/accessible-principals",
        headers,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.principals).toHaveLength(1);
      expect(body.principals[0].principalName).toBe("shared-principal");
      expect(body.principals[0].status).toBe("online");
    });

    it("should return 401 when not authenticated", async () => {
      const app = await buildTestApp({ testDb });
      const response = await app.inject({
        method: "GET",
        url: "/v1/me/accessible-principals",
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe("GET /v1/public/principals/:owner/:principalName", () => {
    it("should return public instance page data", async () => {
      const app = await buildTestApp({ testDb });
      const user = await createUser(testDb.client, {
        namespace: "alice",
        displayName: "Alice",
      });
      await createInstance(testDb.client, {
        ownerId: user.id,
        name: "public-principal",
        exposure: "public",
        publicName: "Alice Principal",
        description: "A principal by Alice",
        capabilities: ["chat", "search"],
        status: "online",
      });

      const response = await app.inject({
        method: "GET",
        url: "/v1/public/principals/alice/public-principal",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.instance.publicName).toBe("Alice Principal");
      expect(body.instance.description).toBe("A principal by Alice");
      expect(body.instance.owner.name).toBe("Alice");
      expect(body.instance.capabilities).toEqual(["chat", "search"]);
      expect(body.instance.status).toBe("online");
    });

    it("should return 404 for non-public instance", async () => {
      const app = await buildTestApp({ testDb });
      const user = await createUser(testDb.client, { namespace: "alice" });
      await createInstance(testDb.client, {
        ownerId: user.id,
        name: "private-principal",
        exposure: "private",
      });

      const response = await app.inject({
        method: "GET",
        url: "/v1/public/principals/alice/private-principal",
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe("POST /v1/public/principals/:owner/:principalName/chat", () => {
    it("should proxy chat for public principal", async () => {
      const app = await buildTestApp({ testDb });
      const user = await createUser(testDb.client, { namespace: "alice" });
      await createInstance(testDb.client, {
        ownerId: user.id,
        name: "public-principal",
        exposure: "public",
        status: "online",
      });

      const response = await app.inject({
        method: "POST",
        url: "/v1/public/principals/alice/public-principal/chat",
        payload: { message: "hello" },
      });

      // Will 502 because no tunnel
      expect(response.statusCode).toBe(502);
    }, 35000);

    it("should require ToS acknowledgment when tos_required is true", async () => {
      const app = await buildTestApp({ testDb });
      const user = await createUser(testDb.client, { namespace: "alice" });
      await createInstance(testDb.client, {
        ownerId: user.id,
        name: "tos-principal",
        exposure: "public",
        status: "online",
        tosRequired: true,
        tosText: "You must agree.",
      });

      const response = await app.inject({
        method: "POST",
        url: "/v1/public/principals/alice/tos-principal/chat",
        payload: { message: "hello" },
      });

      expect(response.statusCode).toBe(428);
      const body = JSON.parse(response.payload);
      expect(body.error).toBe("Terms of Service acknowledgment required");
      expect(body.tosText).toBe("You must agree.");
    });

    it("should return 404 for non-existent public principal", async () => {
      const app = await buildTestApp({ testDb });
      const response = await app.inject({
        method: "POST",
        url: "/v1/public/principals/alice/missing/chat",
        payload: { message: "hello" },
      });
      expect(response.statusCode).toBe(404);
    });
  });
});
