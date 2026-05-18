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

  it('POST /api/v1/auth/logout should clear cookies and return success', async () => {
    const app = await buildTestApp({ testDb });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload)).toEqual({ success: true });

    const setCookie = response.headers['set-cookie'];
    expect(setCookie).toBeDefined();
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    const refreshCookie = cookies.find((c: string) => c.includes('pekohub_refresh='));
    expect(refreshCookie).toBeDefined();
    expect(refreshCookie).toMatch(/Expires=Thu, 01 Jan 1970 00:00:00 GMT|Max-Age=0/);
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

describe('Refresh Token Flow', () => {
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

  it('POST /api/v1/auth/refresh returns 401 when cookie is missing', async () => {
    const app = await buildTestApp({ testDb });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
    });

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.payload)).toEqual({ error: 'Missing refresh token' });
  });

  it('POST /api/v1/auth/refresh returns 401 with invalid token', async () => {
    const app = await buildTestApp({ testDb });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { pekohub_refresh: 'totally-invalid-token' },
    });

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.payload)).toEqual({ error: 'Invalid or expired refresh token' });
  });

  it('POST /api/v1/auth/refresh rotates token and returns new access token', async () => {
    const user = await createUser(testDb.client, {
      namespace: 'alice',
      displayName: 'Alice',
      email: 'alice@example.com',
    });

    const app = await buildTestApp({ testDb });

    // Issue a refresh token via the helper
    const refreshToken = await app.issueRefreshToken(user.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { pekohub_refresh: refreshToken },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.token).toBeDefined();
    expect(typeof body.token).toBe('string');

    // New refresh cookie should be set
    const setCookie = response.headers['set-cookie'];
    expect(setCookie).toBeDefined();
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    const refreshCookie = cookies.find((c: string) => c.includes('pekohub_refresh='));
    expect(refreshCookie).toBeDefined();
    expect(refreshCookie).not.toContain('pekohub_refresh=;');
  });

  it('POST /api/v1/auth/refresh detects token reuse and revokes all tokens', async () => {
    const user = await createUser(testDb.client, {
      namespace: 'alice',
      displayName: 'Alice',
      email: 'alice@example.com',
    });

    const app = await buildTestApp({ testDb });

    // Issue first refresh token
    const refreshToken1 = await app.issueRefreshToken(user.id);

    // First refresh (legitimate)
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { pekohub_refresh: refreshToken1 },
    });
    expect(res1.statusCode).toBe(200);

    // Second refresh with same token (reuse / theft simulation)
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { pekohub_refresh: refreshToken1 },
    });
    expect(res2.statusCode).toBe(401);
    expect(JSON.parse(res2.payload)).toEqual({ error: 'Invalid or expired refresh token' });

    // The reuse detection revokes ALL tokens for the user.
    // Verify by trying to use the new rotated token from res1 — it should also be revoked.
    const setCookie = res1.headers['set-cookie'];
    expect(setCookie).toBeDefined();
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    const rotatedCookie = cookies.find((c: string) => c.startsWith('pekohub_refresh='));
    expect(rotatedCookie).toBeDefined();
    const rotatedToken = rotatedCookie!.split(';')[0].split('=')[1];

    const res3 = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { pekohub_refresh: rotatedToken },
    });
    expect(res3.statusCode).toBe(401);
  });

  it('POST /api/v1/auth/logout revokes refresh token when cookie present', async () => {
    const user = await createUser(testDb.client, {
      namespace: 'alice',
      displayName: 'Alice',
      email: 'alice@example.com',
    });

    const app = await buildTestApp({ testDb });
    const refreshToken = await app.issueRefreshToken(user.id);

    const logoutRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      cookies: { pekohub_refresh: refreshToken },
    });
    expect(logoutRes.statusCode).toBe(200);

    // After logout, the refresh token should be invalid
    const refreshRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { pekohub_refresh: refreshToken },
    });
    expect(refreshRes.statusCode).toBe(401);
  });
});
