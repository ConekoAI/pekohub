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
        ownerSubject: { kind: "user", id: String(user.id) },
        name: "principal-1",
        type: "principal",
      });
      await createInstance(testDb.client, {
        ownerSubject: { kind: "user", id: String(user.id) },
        name: "principal-2",
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
        ownerSubject: { kind: "user", id: String(user.id) },
        name: "online-principal",
        status: "online",
      });
      await createInstance(testDb.client, {
        ownerSubject: { kind: "user", id: String(user.id) },
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
      expect(body.data[0].name).toBe("online-principal");
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
        ownerSubject: { kind: "user", id: String(user.id) },
        name: "my-principal",
      });

      const response = await app.inject({
        method: "GET",
        url: `/v1/instances/${instance.id}`,
        headers,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.name).toBe("my-principal");
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
        name: "public-principal",
        exposure: "public",
        runtimeId: "runtime-secret",
      });

      const response = await app.inject({
        method: "GET",
        url: `/v1/instances/${instance.id}`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.name).toBe("public-principal");
      // Post-H4: `allowedPrincipals` is gone from the wire entirely.
      expect(body.runtimeId).toBeUndefined();
    });

    it("should return full record including runtimeId for owner", async () => {
      const app = await buildTestApp({ testDb });
      const user = await createUser(testDb.client, { namespace: "alice" });
      const headers = await authHeaders(user);
      const instance = await createInstance(testDb.client, {
        ownerSubject: { kind: "user", id: String(user.id) },
        name: "public-principal",
        exposure: "public",
        runtimeId: "runtime-secret",
      });

      const response = await app.inject({
        method: "GET",
        url: `/v1/instances/${instance.id}`,
        headers,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.name).toBe("public-principal");
      expect(body.runtimeId).toBe("runtime-secret");
    });

    it("should redact runtimeId for authenticated non-owner", async () => {
      const app = await buildTestApp({ testDb });
      const owner = await createUser(testDb.client, { namespace: "alice" });
      const viewer = await createUser(testDb.client, { namespace: "bob" });
      const headers = await authHeaders(viewer);
      const instance = await createInstance(testDb.client, {
        name: "public-principal",
        exposure: "public",
        runtimeId: "runtime-secret",
      });

      const response = await app.inject({
        method: "GET",
        url: `/v1/instances/${instance.id}`,
        headers,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.runtimeId).toBeUndefined();
    });

    // Issue #11: the typed `owner_subject` column is also sensitive
    // — it leaks the owner's identity — so it joins the redaction
    // list for non-owners. Post-H4 the legacy `allowed_principals`
    // column is gone, so this assertion no longer covers it.
    it("should redact ownerSubject for non-owner", async () => {
      const app = await buildTestApp({ testDb });
      const owner = await createUser(testDb.client, { namespace: "alice" });
      const viewer = await createUser(testDb.client, { namespace: "bob" });
      const headers = await authHeaders(viewer);
      const instance = await createInstance(testDb.client, {
        name: "typed-principal",
        exposure: "public",
        ownerSubject: { kind: "principal", id: "helper" },
      });

      const response = await app.inject({
        method: "GET",
        url: `/v1/instances/${instance.id}`,
        headers,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.ownerSubject).toBeUndefined();
    });

    it("should return ownerSubject for the owner", async () => {
      const app = await buildTestApp({ testDb });
      const owner = await createUser(testDb.client, { namespace: "alice" });
      const headers = await authHeaders(owner);
      const instance = await createInstance(testDb.client, {
        // The user that registered the row is the resolved owner.
        ownerSubject: { kind: "user", id: String(owner.id) },
        name: "owner-view",
        exposure: "private",
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
    });

    it("should deny access to private instance without auth", async () => {
      const app = await buildTestApp({ testDb });
      const user = await createUser(testDb.client, { namespace: "alice" });
      const instance = await createInstance(testDb.client, {
        name: "private-principal",
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
        ownerSubject: { kind: "user", id: String(user.id) },
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
        name: "my-principal",
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
        ownerSubject: { kind: "user", id: String(user.id) },
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
        name: "my-principal",
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
        name: "public-1",
        exposure: "public",
        status: "online",
      });
      await createInstance(testDb.client, {
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
        name: "private-principal",
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
        name: "private-principal",
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
        name: "public-principal",
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
        name: "tos-principal",
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
        ownerSubject: { kind: "user", id: String(user.id) },
        name: "my-principal",
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
        ownerSubject: { kind: "user", id: String(user.id) },
        name: "my-principal",
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
        name: "my-principal",
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

  describe("GET /v1/me/accessible-pekos", () => {
    // Post-H4: ownership is the only signal — the runtime owns the
    // ACL surface (R4). The endpoint returns the viewer's own
    // private principals by matching `ownerSubject` JSONB equality.
    it("should list the viewer's own private principals", async () => {
      const app = await buildTestApp({ testDb });
      const owner = await createUser(testDb.client, { namespace: "alice" });
      const headers = await authHeaders(owner);

      await createInstance(testDb.client, {
        ownerSubject: { kind: "user", id: String(owner.id) },
        name: "my-private-principal",
        exposure: "private",
        status: "online",
      });

      const response = await app.inject({
        method: "GET",
        url: "/v1/me/accessible-pekos",
        headers,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.pekos).toHaveLength(1);
      expect(body.pekos[0].pekoName).toBe("my-private-principal");
      expect(body.pekos[0].status).toBe("online");
    });

    it("should not list principals owned by a different user", async () => {
      const app = await buildTestApp({ testDb });
      const owner = await createUser(testDb.client, { namespace: "alice" });
      const viewer = await createUser(testDb.client, { namespace: "bob" });
      const headers = await authHeaders(viewer);

      await createInstance(testDb.client, {
        ownerSubject: { kind: "user", id: String(owner.id) },
        name: "alice-private",
        exposure: "private",
        status: "online",
      });

      const response = await app.inject({
        method: "GET",
        url: "/v1/me/accessible-pekos",
        headers,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.pekos).toHaveLength(0);
    });

    it("should return 401 when not authenticated", async () => {
      const app = await buildTestApp({ testDb });
      const response = await app.inject({
        method: "GET",
        url: "/v1/me/accessible-pekos",
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe("GET /v1/public/pekos/:owner/:principalName", () => {
    it("should return public instance page data", async () => {
      const app = await buildTestApp({ testDb });
      const user = await createUser(testDb.client, {
        namespace: "alice",
        displayName: "Alice",
      });
      await createInstance(testDb.client, {
        ownerSubject: { kind: "user", id: String(user.id) },
        name: "public-principal",
        exposure: "public",
        publicName: "Alice Principal",
        description: "A principal by Alice",
        capabilities: ["chat", "search"],
        status: "online",
      });

      const response = await app.inject({
        method: "GET",
        url: "/v1/public/pekos/alice/public-principal",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.liveInstance.publicName).toBe("Alice Principal");
      expect(body.liveInstance.description).toBe("A principal by Alice");
      expect(body.liveInstance.owner.name).toBe("Alice");
      expect(body.liveInstance.capabilities).toEqual(["chat", "search"]);
      expect(body.liveInstance.status).toBe("online");
    });

    it("should return 404 for non-public instance", async () => {
      const app = await buildTestApp({ testDb });
      const user = await createUser(testDb.client, { namespace: "alice" });
      await createInstance(testDb.client, {
        name: "private-principal",
        exposure: "private",
      });

      const response = await app.inject({
        method: "GET",
        url: "/v1/public/pekos/alice/private-principal",
      });

      expect(response.statusCode).toBe(404);
    });

    // PR #2: unlisted is reachable via the public URL but never
    // appears in discovery. The owner shares the link directly.
    it("should return unlisted instance page data (PR #2)", async () => {
      const app = await buildTestApp({ testDb });
      const user = await createUser(testDb.client, {
        namespace: "alice",
        displayName: "Alice",
      });
      await createInstance(testDb.client, {
        ownerSubject: { kind: "user", id: String(user.id) },
        name: "unlisted-principal",
        exposure: "unlisted",
        publicName: "Alice Private Share",
        description: "Share-via-URL",
        status: "online",
      });

      const response = await app.inject({
        method: "GET",
        url: "/v1/public/pekos/alice/unlisted-principal",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.liveInstance.publicName).toBe("Alice Private Share");
      expect(body.liveInstance.description).toBe("Share-via-URL");
    });

    it("should return 404 for unexposed instance even on public URL", async () => {
      const app = await buildTestApp({ testDb });
      const user = await createUser(testDb.client, { namespace: "alice" });
      await createInstance(testDb.client, {
        ownerSubject: { kind: "user", id: String(user.id) },
        name: "hidden-principal",
        exposure: "unexposed",
      });

      const response = await app.inject({
        method: "GET",
        url: "/v1/public/pekos/alice/hidden-principal",
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe("POST /v1/public/pekos/:owner/:principalName/chat", () => {
    it("should proxy chat for public principal", async () => {
      const app = await buildTestApp({ testDb });
      const user = await createUser(testDb.client, { namespace: "alice" });
      await createInstance(testDb.client, {
        ownerSubject: { kind: "user", id: String(user.id) },
        name: "public-principal",
        exposure: "public",
        status: "online",
      });

      const response = await app.inject({
        method: "POST",
        url: "/v1/public/pekos/alice/public-principal/chat",
        payload: { message: "hello" },
      });

      // Will 502 because no tunnel
      expect(response.statusCode).toBe(502);
    }, 35000);

    it("should require ToS acknowledgment when tos_required is true", async () => {
      const app = await buildTestApp({ testDb });
      const user = await createUser(testDb.client, { namespace: "alice" });
      await createInstance(testDb.client, {
        ownerSubject: { kind: "user", id: String(user.id) },
        name: "tos-principal",
        exposure: "public",
        status: "online",
        tosRequired: true,
        tosText: "You must agree.",
      });

      const response = await app.inject({
        method: "POST",
        url: "/v1/public/pekos/alice/tos-principal/chat",
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
        url: "/v1/public/pekos/alice/missing/chat",
        payload: { message: "hello" },
      });
      expect(response.statusCode).toBe(404);
    });
  });
});
