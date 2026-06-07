import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createTestDb, resetTables } from '../fixtures/db.js';
import { buildTestApp } from '../fixtures/app.js';
import { createUser, createInstance } from '../fixtures/factories.js';
import { authHeaders } from '../fixtures/auth.js';
import type { TestDb } from '../fixtures/db.js';

describe('Instance API', () => {
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

  describe('GET /v1/instances', () => {
    it('should list instances owned by the authenticated user', async () => {
      const app = await buildTestApp({ testDb });
      const user = await createUser(testDb.client, { namespace: 'alice' });
      const headers = await authHeaders(user);

      await createInstance(testDb.client, { ownerId: user.id, name: 'agent-1', type: 'agent' });
      await createInstance(testDb.client, { ownerId: user.id, name: 'agent-2', type: 'agent' });

      const response = await app.inject({
        method: 'GET',
        url: '/v1/instances',
        headers,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.data).toHaveLength(2);
      expect(body.total).toBe(2);
    });

    it('should filter by status', async () => {
      const app = await buildTestApp({ testDb });
      const user = await createUser(testDb.client, { namespace: 'alice' });
      const headers = await authHeaders(user);

      await createInstance(testDb.client, { ownerId: user.id, name: 'online-agent', status: 'online' });
      await createInstance(testDb.client, { ownerId: user.id, name: 'offline-agent', status: 'offline' });

      const response = await app.inject({
        method: 'GET',
        url: '/v1/instances?status=online',
        headers,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].name).toBe('online-agent');
    });

    it('should return 401 when not authenticated', async () => {
      const app = await buildTestApp({ testDb });
      const response = await app.inject({
        method: 'GET',
        url: '/v1/instances',
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('GET /v1/instances/:id', () => {
    it('should return instance details for owner', async () => {
      const app = await buildTestApp({ testDb });
      const user = await createUser(testDb.client, { namespace: 'alice' });
      const headers = await authHeaders(user);
      const instance = await createInstance(testDb.client, { ownerId: user.id, name: 'my-agent' });

      const response = await app.inject({
        method: 'GET',
        url: `/v1/instances/${instance.id}`,
        headers,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.name).toBe('my-agent');
    });

    it('should return 404 for non-existent instance', async () => {
      const app = await buildTestApp({ testDb });
      const user = await createUser(testDb.client, { namespace: 'alice' });
      const headers = await authHeaders(user);

      const response = await app.inject({
        method: 'GET',
        url: '/v1/instances/00000000-0000-0000-0000-000000000000',
        headers,
      });

      expect(response.statusCode).toBe(404);
    });

    it('should allow access to public instance without auth', async () => {
      const app = await buildTestApp({ testDb });
      const user = await createUser(testDb.client, { namespace: 'alice' });
      const instance = await createInstance(testDb.client, {
        ownerId: user.id,
        name: 'public-agent',
        exposure: 'public',
      });

      const response = await app.inject({
        method: 'GET',
        url: `/v1/instances/${instance.id}`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.name).toBe('public-agent');
    });

    it('should deny access to private instance without auth', async () => {
      const app = await buildTestApp({ testDb });
      const user = await createUser(testDb.client, { namespace: 'alice' });
      const instance = await createInstance(testDb.client, {
        ownerId: user.id,
        name: 'private-agent',
        exposure: 'private',
      });

      const response = await app.inject({
        method: 'GET',
        url: `/v1/instances/${instance.id}`,
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('POST /v1/instances', () => {
    it('should create a new instance', async () => {
      const app = await buildTestApp({ testDb });
      const user = await createUser(testDb.client, { namespace: 'alice' });
      const headers = await authHeaders(user);

      const response = await app.inject({
        method: 'POST',
        url: '/v1/instances',
        headers,
        payload: {
          type: 'agent',
          name: 'new-agent',
          runtime_id: 'runtime-abc',
          exposure: 'public',
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.payload);
      expect(body.name).toBe('new-agent');
      expect(body.type).toBe('agent');
      expect(body.runtimeId).toBe('runtime-abc');
      expect(body.exposure).toBe('public');
    });

    it('should return 401 when not authenticated', async () => {
      const app = await buildTestApp({ testDb });
      const response = await app.inject({
        method: 'POST',
        url: '/v1/instances',
        payload: { type: 'agent', name: 'new-agent', runtime_id: 'runtime-abc' },
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('PATCH /v1/instances/:id', () => {
    it('should update instance fields', async () => {
      const app = await buildTestApp({ testDb });
      const user = await createUser(testDb.client, { namespace: 'alice' });
      const headers = await authHeaders(user);
      const instance = await createInstance(testDb.client, { ownerId: user.id, name: 'old-name' });

      const response = await app.inject({
        method: 'PATCH',
        url: `/v1/instances/${instance.id}`,
        headers,
        payload: { name: 'new-name', exposure: 'public' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.name).toBe('new-name');
      expect(body.exposure).toBe('public');
    });

    it('should return 403 for non-owner', async () => {
      const app = await buildTestApp({ testDb });
      const owner = await createUser(testDb.client, { namespace: 'alice' });
      const other = await createUser(testDb.client, { namespace: 'bob' });
      const headers = await authHeaders(other);
      const instance = await createInstance(testDb.client, { ownerId: owner.id, name: 'my-agent' });

      const response = await app.inject({
        method: 'PATCH',
        url: `/v1/instances/${instance.id}`,
        headers,
        payload: { name: 'hacked' },
      });

      expect(response.statusCode).toBe(403);
    });
  });

  describe('DELETE /v1/instances/:id', () => {
    it('should delete an instance when authenticated as owner', async () => {
      const app = await buildTestApp({ testDb });
      const user = await createUser(testDb.client, { namespace: 'alice' });
      const headers = await authHeaders(user);
      const instance = await createInstance(testDb.client, { ownerId: user.id, name: 'to-delete' });

      const response = await app.inject({
        method: 'DELETE',
        url: `/v1/instances/${instance.id}`,
        headers,
      });

      expect(response.statusCode).toBe(204);

      const getResponse = await app.inject({
        method: 'GET',
        url: `/v1/instances/${instance.id}`,
        headers,
      });
      expect(getResponse.statusCode).toBe(404);
    });

    it('should return 403 for non-owner', async () => {
      const app = await buildTestApp({ testDb });
      const owner = await createUser(testDb.client, { namespace: 'alice' });
      const other = await createUser(testDb.client, { namespace: 'bob' });
      const headers = await authHeaders(other);
      const instance = await createInstance(testDb.client, { ownerId: owner.id, name: 'my-agent' });

      const response = await app.inject({
        method: 'DELETE',
        url: `/v1/instances/${instance.id}`,
        headers,
      });

      expect(response.statusCode).toBe(403);
    });
  });

  describe('GET /v1/instances/public', () => {
    it('should list public instances without auth', async () => {
      const app = await buildTestApp({ testDb });
      const user = await createUser(testDb.client, { namespace: 'alice' });

      await createInstance(testDb.client, { ownerId: user.id, name: 'public-1', exposure: 'public', status: 'online' });
      await createInstance(testDb.client, { ownerId: user.id, name: 'private-1', exposure: 'private', status: 'online' });

      const response = await app.inject({
        method: 'GET',
        url: '/v1/instances/public',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].name).toBe('public-1');
    });
  });

  describe('POST /v1/instances/:id/chat', () => {
    it('should return 404 for non-existent instance', async () => {
      const app = await buildTestApp({ testDb });
      const response = await app.inject({
        method: 'POST',
        url: '/v1/instances/00000000-0000-0000-0000-000000000000/chat',
        payload: { message: 'hello' },
      });
      expect(response.statusCode).toBe(404);
    });

    it('should require auth for private instance', async () => {
      const app = await buildTestApp({ testDb });
      const user = await createUser(testDb.client, { namespace: 'alice' });
      const instance = await createInstance(testDb.client, {
        ownerId: user.id,
        name: 'private-agent',
        exposure: 'private',
      });

      const response = await app.inject({
        method: 'POST',
        url: `/v1/instances/${instance.id}/chat`,
        payload: { message: 'hello' },
      });

      expect(response.statusCode).toBe(401);
    });

    it('should allow chat to public instance without auth', async () => {
      const app = await buildTestApp({ testDb });
      const user = await createUser(testDb.client, { namespace: 'alice' });
      const instance = await createInstance(testDb.client, {
        ownerId: user.id,
        name: 'public-agent',
        exposure: 'public',
      });

      const response = await app.inject({
        method: 'POST',
        url: `/v1/instances/${instance.id}/chat`,
        payload: { message: 'hello' },
      });

      // Will 502 because no tunnel, but should pass auth/exposure checks
      expect(response.statusCode).toBe(502);
    }, 35000);
  });
});
