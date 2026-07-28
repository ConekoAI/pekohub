import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * PR #7: pin the dashboard-related API helper shapes. These
 * helpers call the hub backend's instance management endpoints
 * (added in post-H4), all of which require a JWT. We assert the
 * wire format (URL path, method, body shape, status mapping) — the
 * actual network call is intercepted at the fetch layer so no
 * pekohub process is required.
 */

import { api, setAuthToken } from '~/lib/api';

const TOKEN = 'test-token-abc';

describe('dashboard api helpers', () => {
  beforeEach(() => {
    setAuthToken(TOKEN);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
        ok: true,
        status: 200,
        json: async () => ({ data: [], total: 0 }),
      })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setAuthToken('');
  });

  it('listOwnedInstances hits /v1/instances with pagination params', async () => {
    await api.listOwnedInstances({ page: 2, perPage: 50 });
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/v1/instances?page=2&per_page=50');
    expect(init.method).toBeUndefined(); // GET
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('listOwnedInstances forwards optional status / exposure filters', async () => {
    await api.listOwnedInstances({ status: 'online', exposure: 'public' });
    const [url] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('status=online');
    expect(url).toContain('exposure=public');
  });

  it('listAccessiblePrincipals hits /v1/me/accessible-principals', async () => {
    await api.listAccessiblePrincipals();
    const [url] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/v1/me/accessible-principals');
  });

  it('getInstance uses the instance id in the path', async () => {
    await api.getInstance('inst-1234');
    const [url] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/v1/instances/inst-1234');
  });

  it('setInstanceExposure PATCHes /v1/instances/:id/exposure with the chosen exposure', async () => {
    await api.setInstanceExposure('inst-1234', 'public');
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/v1/instances/inst-1234/exposure');
    expect(init.method).toBe('PATCH');
    const body = JSON.parse(init.body);
    expect(body.exposure).toBe('public');
  });

  it('setInstanceExposure includes public_profile when provided', async () => {
    await api.setInstanceExposure('inst-1234', 'public', {
      public_name: 'My Agent',
      description: 'A test agent',
      tags: ['ai', 'assistant'],
      category: 'coding',
    });
    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.public_profile.public_name).toBe('My Agent');
    expect(body.public_profile.category).toBe('coding');
  });

  it('setInstanceStatus PATCHes /v1/instances/:id/status', async () => {
    await api.setInstanceStatus('inst-1234', 'busy');
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/v1/instances/inst-1234/status');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ status: 'busy' });
  });

  it('deleteInstance DELETEs /v1/instances/:id (204 accepted as success)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 204, json: async () => ({}) })),
    );
    await expect(api.deleteInstance('inst-1234')).resolves.toBeUndefined();
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/v1/instances/inst-1234');
    expect(init.method).toBe('DELETE');
  });

  it('deleteInstance rejects on non-2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })),
    );
    await expect(api.deleteInstance('inst-1234')).rejects.toThrow();
  });

  it('mintInvite throws not_implemented when the hub returns 404 (PR #11 stub)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: 'not_implemented' }) })),
    );
    await expect(
      api.mintInvite('inst-1234', { scope: ['chat'], ttl_secs: 7 * 86400 }),
    ).rejects.toThrow('not_implemented');
  });
});
