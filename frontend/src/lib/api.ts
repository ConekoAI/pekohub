import type { SearchQuery, SearchResponse, BundleDetail, UserProfile, PublicProfile, PublicChatBody } from '@pekohub/shared';

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

/**
 * Error carrying the HTTP status.
 *
 * Callers routinely need to tell "this resource is gone" (404 → render
 * not-found) apart from "the network is having a bad day" (5xx → render
 * a retry note). The status is never in the response body, so it has to
 * ride the error object.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/** Narrow an unknown throwable to an `ApiError`. */
export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

async function doRefresh(): Promise<string> {
  const res = await fetch(`${API_BASE}/v1/auth/refresh`, {
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

  if (response.status === 401 && !url.includes('/auth/refresh') && !url.includes('/auth/me')) {
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
        throw new ApiError(
          retryResponse.status,
          error.error ?? `HTTP ${retryResponse.status}`,
          error,
        );
      }

      return retryResponse.json() as Promise<T>;
    } catch {
      clearAuthToken();
      window.location.href = '/';
      throw new ApiError(401, 'Session expired');
    }
  }

  if (!response.ok) {
    const error = await response.json().catch(() => null);
    const message =
      (error as { error?: string } | null)?.error ?? `HTTP ${response.status}`;
    throw new ApiError(response.status, message, error);
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
    return fetchJson<SearchResponse>(`/v1/search?${searchParams}`);
  },

  getBundle: (namespace: string, name: string) =>
    fetchJson<BundleDetail>(`/v1/bundles/${namespace}/${name}`),

  getBundleVersions: (namespace: string, name: string) =>
    fetchJson<{ namespace: string; name: string; versions: Array<{ version: string; digest: string; size: number; createdAt: string; deprecated: boolean | null; deprecatedMessage: string | null }> }>(
      `/v1/bundles/${namespace}/${name}/versions`
    ),

  /**
   * OCI catalog — every repository path the registry holds
   * (`peko/principals/<name>` for current templates, plus any
   * pre-ADR-005 two-segment rows). Anonymous; no JWT. The template
   * directory uses this as its listing source because it reads the
   * registry's real contents rather than a derived search index.
   */
  getCatalog: () => fetchJson<CatalogResponse>('/v2/_catalog'),

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
    }>(`/v1/bundles/${namespace}/${name}/versions/${version}/deprecate`, {
      method: 'POST',
      body: JSON.stringify({ deprecated, message }),
    }),

  generateApiKey: (name: string) =>
    fetchJson<{ id: number; name: string; prefix: string; key: string; createdAt: string }>(
      '/v1/auth/api-keys',
      { method: 'POST', body: JSON.stringify({ name }) }
    ),

  listApiKeys: () =>
    fetchJson<{ keys: Array<{ id: number; name: string; prefix: string; createdAt: string; lastUsedAt: string | null }> }>(
      '/v1/auth/api-keys'
    ),

  revokeApiKey: (id: number) =>
    fetch(`${API_BASE}/v1/auth/api-keys/${id}`, { method: 'DELETE', credentials: 'include' }).then((r) => {
      if (!r.ok) throw new Error('Failed to revoke key');
    }),

  getMe: () =>
    fetchJson<UserProfile>('/v1/auth/me'),

  /**
   * Runtimes owned by the caller (ADR-032/058). Every peko is hosted by
   * exactly one runtime, so this is the owner's "where do my pekos
   * live" view. Requires a JWT.
   */
  listRuntimes: () => fetchJson<{ runtimes: RuntimeRecord[] }>('/v1/runtimes'),

  logout: () =>
    fetchJson<void>('/v1/auth/logout', { method: 'POST' }).finally(() => {
      clearAuthToken();
    }),

  deleteBundle: (namespace: string, name: string) =>
    fetch(`${API_BASE}/v1/bundles/${namespace}/${name}`, { method: 'DELETE', credentials: 'include' }).then((r) => {
      if (!r.ok) throw new Error('Failed to delete bundle');
    }),

  deleteVersion: (namespace: string, name: string, version: string) =>
    fetch(`${API_BASE}/v1/bundles/${namespace}/${name}/versions/${version}`, { method: 'DELETE', credentials: 'include' }).then((r) => {
      if (!r.ok) throw new Error('Failed to delete version');
    }),

  // ─────────────────────────────────────────────────────────────────────────
  // Public chat (PR-C) — anonymous, no JWT, visitor cookie round-trip.
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Fetch the public profile for a peko. Used by `/peko/$owner/$pekoName`
   * to render the share-link landing page (description, model,
   * tags, ToS gate, chat input). No JWT — anyone with the link can
   * see this; the visitor cookie is set by the backend so the
   * subsequent `publicChat` call can resolve a thread.
   */
  publicProfile: (owner: string, pekoName: string) =>
    fetchJson<PublicProfile>(`/v1/public/pekos/${owner}/${pekoName}`),

  /**
   * Open a streaming SSE chat with a public peko. Returns the
   * raw `Response` so the caller can attach a body-reader; callers
   * that need a discriminated stream of `chunk | iteration | done |
   * error` events should use `usePublicChat()` which parses the
   * dual-channel SSE format. Throws on network error; quota
   * rejections arrive as an `event: error` SSE frame.
   *
   * No `Authorization` header — public endpoint. The visitor cookie
   * travels via `credentials: 'include'`.
   */
  publicChat: (owner: string, pekoName: string, body: PublicChatBody) =>
    fetch(`${API_BASE}/v1/public/pekos/${owner}/${pekoName}/chat`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),

  // ─────────────────────────────────────────────────────────────────────────
  // Owner dashboard (PR #7) — instances scoped to the signed-in user.
  // Mirrors `GET /v1/instances` on the backend (which already filters
  // by owner subject for any non-admin caller via JWT). For the
  // private-only view, `listAccessiblePekos` below still hits
  // `/v1/me/accessible-pekos`, which post-H4 returns a stripped
  // shape without runtime metadata.
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Owner dashboard primary feed. Lists every instance the caller
   * owns across all exposure levels (`private` / `unlisted` /
   * `public` / `unexposed`), with full metadata (lastSeenAt, runtime
   * display name, category, public profile). Paginated.
   */
  listOwnedInstances: (opts?: { page?: number; perPage?: number; status?: string; exposure?: string }) => {
    const params = new URLSearchParams();
    params.set('page', String(opts?.page ?? 1));
    params.set('per_page', String(opts?.perPage ?? 50));
    if (opts?.status) params.set('status', opts.status);
    if (opts?.exposure) params.set('exposure', opts.exposure);
    return fetchJson<{ data: OwnedInstanceRecord[]; total: number }>(`/v1/instances?${params}`);
  },

  /**
   * Private-only owner view (post-H4 shape — used by the
   * "private discovery" side-panel; the dashboard itself uses
   * `listOwnedInstances`).
   */
  listAccessiblePekos: () =>
    fetchJson<{
      pekos: Array<{
        id: string;
        ownerName: string;
        pekoName: string;
        publicName: string | null;
        status: 'online' | 'offline' | 'busy' | 'error';
      }>;
    }>(`/v1/me/accessible-pekos`),

  /** Single-instance fetch (owner view; non-owners get a redacted shape). */
  getInstance: (id: string) => fetchJson<OwnedInstanceRecord>(`/v1/instances/${id}`),

  /**
   * Change exposure (triggers search-index sync + tunnel control
   * notification). Body shape matches the backend Zod schema.
   */
  setInstanceExposure: (
    id: string,
    exposure: 'private' | 'public' | 'unexposed' | 'unlisted',
    publicProfile?: {
      public_name: string;
      description: string;
      tags: string[];
      category: string;
      tos_required?: boolean;
      tos_text?: string;
      daily_quota?: number;
      weekly_quota?: number;
    },
  ) =>
    fetchJson<{ instance: OwnedInstanceRecord; tunnelStatus: 'opened' | 'already_open' | 'closed' }>(
      `/v1/instances/${id}/exposure`,
      {
        method: 'PATCH',
        body: JSON.stringify({ exposure, public_profile: publicProfile }),
      },
    ),

  /** Change status (online/offline/busy/error). Notifies the runtime over the tunnel. */
  setInstanceStatus: (id: string, status: 'online' | 'offline' | 'busy' | 'error') =>
    fetchJson<{ instance: OwnedInstanceRecord; tunnelStatus: 'opened' | 'already_open' | 'closed' }>(
      `/v1/instances/${id}/status`,
      {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      },
    ),

  /** Delete (deregister) an instance. 204 No Content on success. */
  deleteInstance: (id: string) =>
    fetch(`${API_BASE}/v1/instances/${id}`, {
      method: 'DELETE',
      credentials: 'include',
    }).then((r) => {
      if (!r.ok && r.status !== 204) {
        throw new Error('Failed to delete instance');
      }
    }),

  /**
   * Mint an invite token for an instance. Returns a stubbed `not_implemented`
   * envelope until PR #11 wires the runtime side. Kept on the client
   * so PR #7 callers don't need to change again.
   */
  mintInvite: (
    id: string,
    body: { scope: string[]; ttl_secs: number },
  ): Promise<{ token: string; url: string; expiresAt: string; jti: string }> =>
    fetch(`${API_BASE}/v1/instances/${id}/invites`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getAuthToken()}`,
      },
      body: JSON.stringify(body),
    }).then(async (r) => {
      if (r.status === 404 || r.status === 501) {
        // PR #11 not yet wired — surface a typed result so the UI can
        // render a "coming soon" message instead of crashing.
        throw new Error('not_implemented');
      }
      if (!r.ok) {
        const err = await r.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error ?? `HTTP ${r.status}`);
      }
      return r.json();
    }),

  // ─────────────────────────────────────────────────────────────────────────
  // Discovery (PR #8) — public peko browse + curated feeds.
  // Anonymous endpoints (no JWT). Results are a flattened
  // `DiscoveryHit` shape — no runtime metadata, no ownerSubject,
  // just the public profile the /peko/$owner/$pekoName landing page
  // shows. The `ownerName` field is the human-readable namespace the
  // share-link path uses; we surface it directly so the card can
  // build the share URL without a second round-trip.
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Public search. `q` is a free-text query against public_name +
   * description + tags; `category` filters by the public category
   * enum; `sort` is one of `trending` (createdAt desc), `new`
   * (publishedAt desc), `featured` (featured + createdAt desc),
   * or default (createdAt desc).
   */
  discoverySearch: (opts?: { q?: string; category?: string; sort?: string; page?: number; perPage?: number }) => {
    const params = new URLSearchParams();
    if (opts?.q) params.set('q', opts.q);
    if (opts?.category) params.set('category', opts.category);
    if (opts?.sort) params.set('sort', opts.sort);
    params.set('page', String(opts?.page ?? 1));
    params.set('per_page', String(opts?.perPage ?? 24));
    return fetchJson<{
      hits: DiscoveryHit[];
      total: number;
      page: number;
    }>(`/v1/discovery/search?${params}`);
  },

  /**
   * Curated feed. `name` is one of `trending` / `new` / `featured`.
   * Returns the same hit shape as `discoverySearch`, with `feed`
   * echoed back so the SPA can label the section header.
   */
  discoveryFeed: (name: 'trending' | 'new' | 'featured', opts?: { page?: number; perPage?: number }) => {
    const params = new URLSearchParams();
    params.set('page', String(opts?.page ?? 1));
    params.set('per_page', String(opts?.perPage ?? 24));
    return fetchJson<{
      hits: DiscoveryHit[];
      total: number;
      page: number;
      feed: string;
    }>(`/v1/discovery/feed/${name}?${params}`);
  },
};

/**
 * Shape returned by `GET /v1/discovery/search` and
 * `GET /v1/discovery/feed/:feed`. Mirrors the backend response in
 * `backend/src/routes/api/instances.ts:898-911`. No `runtimeId` /
 * `ownerSubject` is leaked — discovery is strictly public.
 */
export interface DiscoveryHit {
  id: string;
  publicName: string;
  description: string | null;
  /** Human-readable label (`users.displayName`). Not addressable. */
  ownerName: string;
  /**
   * Addressable owner handle (`users.namespace`). `/peko/:owner` resolves
   * against this, so share links must use it — `ownerName` is only a
   * label and can differ from the namespace.
   */
  ownerNamespace: string | null;
  ownerAvatarUrl: string | null;
  category: string | null;
  tags: string[];
  status: 'online' | 'offline' | 'busy' | 'error';
  publishedAt: string | null;
  featured: boolean;
}

/** The handle a share link must be built from. */
export function ownerHandle(hit: DiscoveryHit): string {
  return hit.ownerNamespace ?? hit.ownerName;
}

/**
 * Build the canonical share URL for a discovery hit
 * (`/peko/:owner/:pekoName`, ADR-005 §1).
 */
export function shareUrlFor(hit: DiscoveryHit, origin?: string): string {
  const base = origin ?? (typeof window !== 'undefined' ? window.location.origin : '');
  return `${base}/peko/${encodeURIComponent(ownerHandle(hit))}/${encodeURIComponent(hit.publicName)}`;
}

/**
 * Shape returned by `GET /v2/_catalog` (OCI Distribution v1.1).
 * Repository paths are multi-segment, e.g. `peko/principals/my-peko`.
 */
export interface CatalogResponse {
  repositories: string[];
}

/**
 * One row from `GET /v1/runtimes`. Mirrors the `runtimes` table — the
 * DID is the identity, `displayName` is operator-set, `lastSeenAt` is
 * refreshed on every tunnel heartbeat.
 */
export interface RuntimeRecord {
  id: number;
  runtimeDid: string;
  ownerId: string;
  displayName: string | null;
  lastSeenAt: string | null;
  createdAt: string;
}

/** One version row from `GET /v1/bundles/:namespace/:name/versions`. */
export interface TemplateVersion {
  version: string;
  digest: string;
  size: number;
  createdAt: string;
  deprecated: boolean | null;
  deprecatedMessage: string | null;
}

export interface TemplateVersionsResponse {
  namespace: string;
  name: string;
  versions: TemplateVersion[];
}

// Shape returned by GET /v1/instances for the owner. Mirrors
// `InstanceRecord` in `backend/src/services/instances.ts:106-155`.
// Local mirror — the shared package doesn't export this type yet
// because the bundle search types are the only ones the SPA needs
// from shared today.
export interface OwnedInstanceRecord {
  id: string;
  type: 'principal';
  name: string;
  ownerSubject: { kind: 'user'; id: string } | null;
  runtimeId: string;
  runtimeDisplayName: string | null;
  bundleRef: string | null;
  status: 'online' | 'offline' | 'busy' | 'error';
  exposure: 'private' | 'public' | 'unexposed' | 'unlisted';
  lastSeenAt: string | null;
  createdAt: string;
  capabilities: string[];
  metadata: Record<string, unknown>;
  publicName: string | null;
  description: string | null;
  tags: string[];
  category: string | null;
  tosRequired: boolean;
  tosText: string | null;
  dailyQuota: number | null;
  weeklyQuota: number | null;
  publishedAt: string | null;
  featured: boolean;
  monetization: {
    enabled: boolean;
    pricingModel: 'free' | 'subscription' | 'usage' | null;
    priceCents: number | null;
    stripeProductId: string | null;
  };
  // `type` and `principalDid` are wire values — the runtime's machine
  // naming stays "principal" even though the UI calls these "pekos".
  principalDid: string | null;
}
