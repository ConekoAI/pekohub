import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createTestDb, resetTables } from "../fixtures/db.js";
import { buildTestApp } from "../fixtures/app.js";
import {
  createUser,
  createBundle,
  createBundleWithVersions,
  createBundleVersion,
} from "../fixtures/factories.js";
import { authHeaders } from "../fixtures/auth.js";
import type { TestDb } from "../fixtures/db.js";
import { resetThrottleForTests } from "../../src/services/throttle.js";

describe("Bundle API", () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  });

  beforeEach(async () => {
    await resetTables(testDb.client);
    resetThrottleForTests();
  });

  afterAll(async () => {
    await testDb.client.close();
  });

  describe("GET /v1/bundles/:namespace/:name", () => {
    it("should return a bundle by namespace and name", async () => {
      const app = await buildTestApp({ testDb });
      const bundle = await createBundle(testDb.client, {
        namespace: "acme",
        name: "my-principal",
        description: "A test agent",
      });

      const response = await app.inject({
        method: "GET",
        url: `/v1/bundles/${bundle.namespace}/${bundle.name}`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body).toMatchObject({
        namespace: "acme",
        name: "my-principal",
        metadata: {
          description: "A test agent",
        },
      });
    });

    it("should return 404 for non-existent bundle", async () => {
      const app = await buildTestApp({ testDb });

      const response = await app.inject({
        method: "GET",
        url: "/v1/bundles/nonexistent/missing",
      });

      expect(response.statusCode).toBe(404);
    });

    it("should return extension metadata including hooks and compatibility", async () => {
      const app = await buildTestApp({ testDb });
      const bundle = await createBundle(testDb.client, {
        namespace: "acme",
        name: "my-extension",
        bundleType: "extension",
        extensionType: "skill",
        description: "A test extension",
        hooks: [
          { point: "tool.register", handler: "registerTools" },
          { point: "agent.init", handler: "onInit" },
        ],
        compatibility: {
          runtime: "peko",
          minVersion: "1.0.0",
          maxVersion: "2.0.0",
        },
      });

      const response = await app.inject({
        method: "GET",
        url: `/v1/bundles/${bundle.namespace}/${bundle.name}`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.metadata.bundleType).toBe("extension");
      expect(body.metadata.extensionType).toBe("skill");
      expect(body.metadata.hooks).toHaveLength(2);
      expect(body.metadata.hooks[0]).toMatchObject({
        point: "tool.register",
        handler: "registerTools",
      });
      expect(body.metadata.compatibility).toMatchObject({
        runtime: "peko",
        minVersion: "1.0.0",
        maxVersion: "2.0.0",
      });
    });
  });

  describe("GET /v1/bundles/:namespace/:name/versions", () => {
    it("should return all versions for a bundle", async () => {
      const app = await buildTestApp({ testDb });
      const { bundle, versions } = await createBundleWithVersions(
        testDb.client,
        3,
        {
          bundle: { namespace: "acme", name: "my-principal" },
        },
      );

      const response = await app.inject({
        method: "GET",
        url: `/v1/bundles/${bundle.namespace}/${bundle.name}/versions`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.versions).toHaveLength(3);
      expect(body.versions.map((v: any) => v.version)).toContain("v1.0.0");
      expect(body.versions.map((v: any) => v.version)).toContain("v2.0.0");
      expect(body.versions.map((v: any) => v.version)).toContain("v3.0.0");
    });
  });

  describe("POST /v1/bundles/:namespace/:name/versions/:version/deprecate", () => {
    it("should deprecate a version when authenticated", async () => {
      const app = await buildTestApp({ testDb });
      const user = await createUser(testDb.client, { namespace: "acme" });
      const { bundle, versions } = await createBundleWithVersions(
        testDb.client,
        1,
        {
          bundle: { namespace: "acme", name: "my-principal" },
        },
      );
      const headers = await authHeaders(user);

      const response = await app.inject({
        method: "POST",
        url: `/v1/bundles/${bundle.namespace}/${bundle.name}/versions/${versions[0].version}/deprecate`,
        headers,
        payload: {
          deprecated: true,
          message: "This version is deprecated",
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.deprecated).toBe(true);
      expect(body.deprecatedMessage).toBe("This version is deprecated");
    });

    it("should return 401 when not authenticated", async () => {
      const app = await buildTestApp({ testDb });
      const { bundle, versions } = await createBundleWithVersions(
        testDb.client,
        1,
        {
          bundle: { namespace: "acme", name: "my-principal" },
        },
      );

      const response = await app.inject({
        method: "POST",
        url: `/v1/bundles/${bundle.namespace}/${bundle.name}/versions/${versions[0].version}/deprecate`,
        payload: {
          deprecated: true,
          message: "Deprecated",
        },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe("DELETE /v1/bundles/:namespace/:name", () => {
    it("should delete a bundle when authenticated as owner", async () => {
      const app = await buildTestApp({ testDb });
      const user = await createUser(testDb.client, { namespace: "acme" });
      const bundle = await createBundle(testDb.client, {
        namespace: "acme",
        name: "my-principal",
      });
      const headers = await authHeaders(user);

      const response = await app.inject({
        method: "DELETE",
        url: `/v1/bundles/${bundle.namespace}/${bundle.name}`,
        headers,
      });

      expect(response.statusCode).toBe(204);
    });

    it("should return 401 when not authenticated", async () => {
      const app = await buildTestApp({ testDb });
      const bundle = await createBundle(testDb.client, {
        namespace: "acme",
        name: "my-principal",
      });

      const response = await app.inject({
        method: "DELETE",
        url: `/v1/bundles/${bundle.namespace}/${bundle.name}`,
      });

      expect(response.statusCode).toBe(401);
    });

    it("should delete orphaned blobs and storage objects immediately on bundle delete", async () => {
      const app = await buildTestApp({ testDb });
      const user = await createUser(testDb.client, { namespace: "acme" });
      const bundle = await createBundle(testDb.client, {
        namespace: "acme",
        name: "my-principal",
      });
      const digest =
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const storageKey = `blobs/${digest}`;

      // Insert blob into DB and storage
      await testDb.client.query(
        `INSERT INTO blobs (digest, size, media_type, storage_key)
         VALUES ($1, $2, $3, $4)`,
        [digest, 100, "application/octet-stream", storageKey],
      );
      await app.storage.put(storageKey, Buffer.from("blob content"));
      expect(await app.storage.exists(storageKey)).toBe(true);

      // Create a version referencing this blob
      await createBundleVersion(testDb.client, bundle.id, {
        version: "v1.0.0",
        digest,
        manifestJson: {
          schemaVersion: 2,
          layers: [{ digest, size: 100, mediaType: "application/octet-stream" }],
          config: { digest, size: 100, mediaType: "application/vnd.oci.image.config.v1+json" },
        },
        size: 200,
      });

      const headers = await authHeaders(user);
      const response = await app.inject({
        method: "DELETE",
        url: `/v1/bundles/${bundle.namespace}/${bundle.name}`,
        headers,
      });

      expect(response.statusCode).toBe(204);

      // Blob should be removed from storage within the same request
      expect(await app.storage.exists(storageKey)).toBe(false);

      // Blob row should also be deleted from the database
      const blobResult = await testDb.client.query(
        `SELECT 1 FROM blobs WHERE digest = $1`,
        [digest],
      );
      expect(blobResult.rows.length).toBe(0);
    });
  });
});
