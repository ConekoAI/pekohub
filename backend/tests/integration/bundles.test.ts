import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createTestDb, resetTables } from '../fixtures/db.js';
import { buildTestApp } from '../fixtures/app.js';
import { createUser, createBundle, createBundleWithVersions } from '../fixtures/factories.js';
import { authHeaders } from '../fixtures/auth.js';
import type { TestDb } from '../fixtures/db.js';

describe('Bundle API', () => {
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

  describe('GET /api/v1/bundles/:namespace/:name', () => {
    it('should return a bundle by namespace and name', async () => {
      const app = await buildTestApp({ testDb });
      const bundle = await createBundle(testDb.client, {
        namespace: 'acme',
        name: 'my-agent',
        description: 'A test agent',
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/bundles/${bundle.namespace}/${bundle.name}`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body).toMatchObject({
        namespace: 'acme',
        name: 'my-agent',
        metadata: {
          description: 'A test agent',
        },
      });
    });

    it('should return 404 for non-existent bundle', async () => {
      const app = await buildTestApp({ testDb });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/bundles/nonexistent/missing',
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('GET /api/v1/bundles/:namespace/:name/versions', () => {
    it('should return all versions for a bundle', async () => {
      const app = await buildTestApp({ testDb });
      const { bundle, versions } = await createBundleWithVersions(testDb.client, 3, {
        bundle: { namespace: 'acme', name: 'my-agent' },
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/bundles/${bundle.namespace}/${bundle.name}/versions`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.versions).toHaveLength(3);
      expect(body.versions.map((v: any) => v.version)).toContain('v1.0.0');
      expect(body.versions.map((v: any) => v.version)).toContain('v2.0.0');
      expect(body.versions.map((v: any) => v.version)).toContain('v3.0.0');
    });
  });

  describe('POST /api/v1/bundles/:namespace/:name/versions/:version/deprecate', () => {
    it('should deprecate a version when authenticated', async () => {
      const app = await buildTestApp({ testDb });
      const user = await createUser(testDb.client, { namespace: 'acme' });
      const { bundle, versions } = await createBundleWithVersions(testDb.client, 1, {
        bundle: { namespace: 'acme', name: 'my-agent' },
      });
      const headers = await authHeaders(user);

      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/bundles/${bundle.namespace}/${bundle.name}/versions/${versions[0].version}/deprecate`,
        headers,
        payload: {
          deprecated: true,
          message: 'This version is deprecated',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.deprecated).toBe(true);
      expect(body.deprecatedMessage).toBe('This version is deprecated');
    });

    it('should return 401 when not authenticated', async () => {
      const app = await buildTestApp({ testDb });
      const { bundle, versions } = await createBundleWithVersions(testDb.client, 1, {
        bundle: { namespace: 'acme', name: 'my-agent' },
      });

      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/bundles/${bundle.namespace}/${bundle.name}/versions/${versions[0].version}/deprecate`,
        payload: {
          deprecated: true,
          message: 'Deprecated',
        },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('DELETE /api/v1/bundles/:namespace/:name', () => {
    it('should delete a bundle when authenticated as owner', async () => {
      const app = await buildTestApp({ testDb });
      const user = await createUser(testDb.client, { namespace: 'acme' });
      const bundle = await createBundle(testDb.client, {
        namespace: 'acme',
        name: 'my-agent',
      });
      const headers = await authHeaders(user);

      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/bundles/${bundle.namespace}/${bundle.name}`,
        headers,
      });

      expect(response.statusCode).toBe(204);
    });

    it('should return 401 when not authenticated', async () => {
      const app = await buildTestApp({ testDb });
      const bundle = await createBundle(testDb.client, {
        namespace: 'acme',
        name: 'my-agent',
      });

      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/bundles/${bundle.namespace}/${bundle.name}`,
      });

      expect(response.statusCode).toBe(401);
    });
  });
});
