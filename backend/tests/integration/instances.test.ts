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
        type: "agent",
      });
      await createInstance(testDb.client, {
        ownerId: user.id,
        name: "agent-2",
        type: "agent",
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
        allowedUsers: ["999"],
        runtimeId: "runtime-secret",
      });

      const response = await app.inject({
        method: "GET",
        url: `/v1/instances/${instance.id}`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.name).toBe("public-agent");
      expect(body.allowedUsers).toBeUndefined();
      expect(body.runtimeId).toBeUndefined();
    });

    it("should return full record including allowedUsers and runtimeId for owner", async () => {
      const app = await buildTestApp({ testDb });
      const user = await createUser(testDb.client, { namespace: "alice" });
      const headers = await authHeaders(user);
      const instance = await createInstance(testDb.client, {
        ownerId: user.id,
        name: "public-agent",
        exposure: "public",
        allowedUsers: [String(user.id)],
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
      expect(body.allowedUsers).toEqual([String(user.id)]);
      expect(body.runtimeId).toBe("runtime-secret");
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
          type: "agent",
          name: "new-agent",
          runtime_id: "runtime-abc",
          exposure: "public",
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.payload);
      expect(body.name).toBe("new-agent");
      expect(body.type).toBe("agent");
      expect(body.runtimeId).toBe("runtime-abc");
      expect(body.exposure).toBe("public");
    });

    it("should return 401 when not authenticated", async () => {
      const app = await buildTestApp({ testDb });
      const response = await app.inject({
        method: "POST",
        url: "/v1/instances",
        payload: {
          type: "agent",
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

  describe("GET /v1/me/shared-instances", () => {
    it("should list private instances shared with the user", async () => {
      const app = await buildTestApp({ testDb });
      const owner = await createUser(testDb.client, { namespace: "alice" });
      const viewer = await createUser(testDb.client, { namespace: "bob" });
      const headers = await authHeaders(viewer);

      await createInstance(testDb.client, {
        ownerId: owner.id,
        name: "shared-agent",
        exposure: "private",
        allowedUsers: [String(viewer.id)],
        status: "online",
      });

      const response = await app.inject({
        method: "GET",
        url: "/v1/me/shared-instances",
        headers,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.instances).toHaveLength(1);
      expect(body.instances[0].agentName).toBe("shared-agent");
      expect(body.instances[0].status).toBe("online");
    });

    it("should return 401 when not authenticated", async () => {
      const app = await buildTestApp({ testDb });
      const response = await app.inject({
        method: "GET",
        url: "/v1/me/shared-instances",
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe("GET /v1/public/agents/:owner/:agentName", () => {
    it("should return public instance page data", async () => {
      const app = await buildTestApp({ testDb });
      const user = await createUser(testDb.client, {
        namespace: "alice",
        displayName: "Alice",
      });
      await createInstance(testDb.client, {
        ownerId: user.id,
        name: "public-agent",
        exposure: "public",
        publicName: "Alice Agent",
        description: "An agent by Alice",
        capabilities: ["chat", "search"],
        status: "online",
      });

      const response = await app.inject({
        method: "GET",
        url: "/v1/public/agents/alice/public-agent",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.instance.publicName).toBe("Alice Agent");
      expect(body.instance.description).toBe("An agent by Alice");
      expect(body.instance.owner.name).toBe("Alice");
      expect(body.instance.capabilities).toEqual(["chat", "search"]);
      expect(body.instance.status).toBe("online");
    });

    it("should return 404 for non-public instance", async () => {
      const app = await buildTestApp({ testDb });
      const user = await createUser(testDb.client, { namespace: "alice" });
      await createInstance(testDb.client, {
        ownerId: user.id,
        name: "private-agent",
        exposure: "private",
      });

      const response = await app.inject({
        method: "GET",
        url: "/v1/public/agents/alice/private-agent",
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe("POST /v1/public/agents/:owner/:agentName/chat", () => {
    it("should proxy chat for public agent", async () => {
      const app = await buildTestApp({ testDb });
      const user = await createUser(testDb.client, { namespace: "alice" });
      await createInstance(testDb.client, {
        ownerId: user.id,
        name: "public-agent",
        exposure: "public",
        status: "online",
      });

      const response = await app.inject({
        method: "POST",
        url: "/v1/public/agents/alice/public-agent/chat",
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
        name: "tos-agent",
        exposure: "public",
        status: "online",
        tosRequired: true,
        tosText: "You must agree.",
      });

      const response = await app.inject({
        method: "POST",
        url: "/v1/public/agents/alice/tos-agent/chat",
        payload: { message: "hello" },
      });

      expect(response.statusCode).toBe(428);
      const body = JSON.parse(response.payload);
      expect(body.error).toBe("Terms of Service acknowledgment required");
      expect(body.tosText).toBe("You must agree.");
    });

    it("should return 404 for non-existent public agent", async () => {
      const app = await buildTestApp({ testDb });
      const response = await app.inject({
        method: "POST",
        url: "/v1/public/agents/alice/missing/chat",
        payload: { message: "hello" },
      });
      expect(response.statusCode).toBe(404);
    });
  });

  describe("GET /v1/instances/:id/analytics", () => {
    it("should return analytics for owner", async () => {
      const app = await buildTestApp({ testDb });
      const user = await createUser(testDb.client, { namespace: "alice" });
      const headers = await authHeaders(user);
      const instance = await createInstance(testDb.client, {
        ownerId: user.id,
        name: "my-agent",
      });

      const response = await app.inject({
        method: "GET",
        url: `/v1/instances/${instance.id}/analytics`,
        headers,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body).toHaveProperty("totalSessions");
      expect(body).toHaveProperty("uniqueVisitors");
      expect(body).toHaveProperty("avgSessionLengthSeconds");
      expect(body).toHaveProperty("period");
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
        method: "GET",
        url: `/v1/instances/${instance.id}/analytics`,
        headers,
      });

      expect(response.statusCode).toBe(403);
    });
  });
});
