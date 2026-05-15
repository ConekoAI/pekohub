import type { SearchQuery, SearchResponse, BundleDetail } from '@pekohub/shared';

const API_BASE = '';

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${url}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

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
    fetchJson<{ namespace: string; name: string; versions: Array<{ version: string; digest: string; size: number; createdAt: string }> }>(
      `/api/v1/bundles/${namespace}/${name}/versions`
    ),

  getCatalog: () =>
    fetchJson<{ repositories: string[] }>('/v2/_catalog'),
};
