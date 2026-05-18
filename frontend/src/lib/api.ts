import type { SearchQuery, SearchResponse, BundleDetail, UserProfile } from '@pekohub/shared';

declare const __API_BASE__: string;
export const API_BASE = typeof __API_BASE__ !== 'undefined' ? __API_BASE__ : '';

const TOKEN_KEY = 'pekohub_token';

let isRefreshing = false;
let refreshPromise: Promise<string> | null = null;

export function getAuthToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setAuthToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearAuthToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

async function doRefresh(): Promise<string> {
  const res = await fetch(`${API_BASE}/api/v1/auth/refresh`, {
    method: 'POST',
    credentials: 'include',
  });

  if (!res.ok) {
    throw new Error('Refresh failed');
  }

  const data = await res.json() as { token: string };
  setAuthToken(data.token);
  return data.token;
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const token = getAuthToken();
  const response = await fetch(`${API_BASE}${url}`, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options?.headers,
    },
  });

  if (response.status === 401 && !url.includes('/auth/refresh')) {
    // Attempt to refresh the access token
    if (!isRefreshing) {
      isRefreshing = true;
      refreshPromise = doRefresh().finally(() => {
        isRefreshing = false;
        refreshPromise = null;
      });
    }

    try {
      const newToken = await refreshPromise!;
      // Retry original request with new token
      const retryResponse = await fetch(`${API_BASE}${url}`, {
        ...options,
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${newToken}`,
          ...options?.headers,
        },
      });

      if (!retryResponse.ok) {
        const error = await retryResponse.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(error.error ?? `HTTP ${retryResponse.status}`);
      }

      return retryResponse.json() as Promise<T>;
    } catch {
      clearAuthToken();
      window.location.href = '/';
      throw new Error('Session expired');
    }
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error ?? `HTTP ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export const api = {
  search: (params: SearchQuery) => {
    const searchParams = new URLSearchParams();
    searchParams.set('q', params.q);
    searchParams.set('page', String(params.page));
    searchParams.set('perPage', String(params.perPage));
    if (params.filters) {
      for (const [key, value] of Object.entries(params.filters)) {
        if (value) searchParams.set(`filters.${key}`, String(value));
      }
    }
    return fetchJson<SearchResponse>(`/api/v1/search?${searchParams}`);
  },

  getBundle: (namespace: string, name: string) =>
    fetchJson<BundleDetail>(`/api/v1/bundles/${namespace}/${name}`),

  getBundleVersions: (namespace: string, name: string) =>
    fetchJson<{ namespace: string; name: string; versions: Array<{ version: string; digest: string; size: number; createdAt: string; deprecated: boolean | null; deprecatedMessage: string | null }> }>(
      `/api/v1/bundles/${namespace}/${name}/versions`
    ),

  getCatalog: () =>
    fetchJson<{ repositories: string[] }>('/v2/_catalog'),

  deprecateVersion: (
    namespace: string,
    name: string,
    version: string,
    deprecated: boolean,
    message?: string
  ) =>
    fetchJson<{
      namespace: string;
      name: string;
      version: string;
      deprecated: boolean | null;
      deprecatedMessage: string | null;
    }>(`/api/v1/bundles/${namespace}/${name}/versions/${version}/deprecate`, {
      method: 'POST',
      body: JSON.stringify({ deprecated, message }),
    }),

  generateApiKey: (name: string) =>
    fetchJson<{ id: number; name: string; prefix: string; key: string; createdAt: string }>(
      '/api/v1/auth/api-keys',
      { method: 'POST', body: JSON.stringify({ name }) }
    ),

  listApiKeys: () =>
    fetchJson<{ keys: Array<{ id: number; name: string; prefix: string; createdAt: string; lastUsedAt: string | null }> }>(
      '/api/v1/auth/api-keys'
    ),

  revokeApiKey: (id: number) =>
    fetch(`${API_BASE}/api/v1/auth/api-keys/${id}`, { method: 'DELETE', credentials: 'include' }).then((r) => {
      if (!r.ok) throw new Error('Failed to revoke key');
    }),

  getMe: () =>
    fetchJson<UserProfile>('/api/v1/auth/me'),

  logout: () =>
    fetchJson<void>('/api/v1/auth/logout', { method: 'POST' }).finally(() => {
      clearAuthToken();
    }),

  forkBundle: (namespace: string, name: string, targetName?: string) =>
    fetchJson<{ namespace: string; name: string; forkedFrom: string | null; versionsCopied: number }>(
      `/api/v1/bundles/${namespace}/${name}/fork${targetName ? `?targetName=${encodeURIComponent(targetName)}` : ''}`,
      { method: 'POST' }
    ),

  deleteBundle: (namespace: string, name: string) =>
    fetch(`${API_BASE}/api/v1/bundles/${namespace}/${name}`, { method: 'DELETE', credentials: 'include' }).then((r) => {
      if (!r.ok) throw new Error('Failed to delete bundle');
    }),

  deleteVersion: (namespace: string, name: string, version: string) =>
    fetch(`${API_BASE}/api/v1/bundles/${namespace}/${name}/versions/${version}`, { method: 'DELETE', credentials: 'include' }).then((r) => {
      if (!r.ok) throw new Error('Failed to delete version');
    }),
};
