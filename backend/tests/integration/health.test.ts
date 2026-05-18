import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createTestDb, resetTables } from '../fixtures/db.js';
import { buildTestApp } from '../fixtures/app.js';
import { createUser } from '../fixtures/factories.js';
import { authHeaders } from '../fixtures/auth.js';
import type { TestDb } from '../fixtures/db.js';

describe('Health Check', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  });

  afterAll(async () => {
    await testDb.client.close();
  });

  it('should return ok status', async () => {
    const app = await buildTestApp({ testDb });

    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload)).toEqual({
      status: 'ok',
      version: '0.1.0',
    });
  });
});

describe('Auth Endpoints', () => {
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

  it('GET /api/v1/auth/me should return 401 without token', async () => {
    const app = await buildTestApp({ testDb });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
    });

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.payload)).toHaveProperty('error');
  });

  it('GET /api/v1/auth/me should return user with valid token', async () => {
    const user = await createUser(testDb.client, {
      namespace: 'testuser',
      displayName: 'Test User',
      email: 'test@example.com',
    });

    const headers = await authHeaders(user);
    const app = await buildTestApp({ testDb });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body).toMatchObject({
      id: user.id,
      namespace: 'testuser',
      displayName: 'Test User',
      email: 'test@example.com',
    });
  });

  it('POST /api/v1/auth/logout should clear cookie', async () => {
    const app = await buildTestApp({ testDb });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload)).toEqual({ success: true });
  });

  it('GET /api/v1/auth/github/authorize should redirect when OAuth is enabled', async () => {
    const app = await buildTestApp({ testDb, enableOAuth: true });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/github/authorize',
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain('github.com');
  });

  it('GET /api/v1/auth/github/authorize should return 400 when OAuth is disabled', async () => {
    const app = await buildTestApp({ testDb, enableOAuth: false });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/github/authorize',
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.payload)).toHaveProperty('error');
  });
});
