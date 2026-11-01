import type { SearchQuery, SearchResponse, UserProfile, PublicProfile } from '@pekohub/shared';

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

/** A request answered with 204 / no body; errors carry the server's message. */
async function fetchNoContent(url: string, method = 'DELETE'): Promise<void> {
  const token = getAuthToken();
  const response = await fetch(`${API_BASE}${url}`, {
    method,
    credentials: 'include',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    throw new ApiError(response.status, error.error ?? `HTTP ${response.status}`, error);
  }
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

  // ── Seeds (the registry) ────────────────────────────────────────────────
  listSeeds: (opts?: { page?: number; perPage?: number }) => {
    const params = new URLSearchParams();
    if (opts?.page) params.set('page', String(opts.page));
    if (opts?.perPage) params.set('perPage', String(opts.perPage));
    return fetchJson<SeedList>(`/v1/seeds?${params}`);
  },

  getSeed: (owner: string, name: string) =>
    fetchJson<SeedDetail>(`/v1/seeds/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`),

  publishSeed: (body: { seed: string; version: string; readme?: string }) =>
    fetchJson<SeedPublished>('/v1/seeds', { method: 'POST', body: JSON.stringify(body) }),

  setSeedVersionDeprecated: (owner: string, name: string, version: string, deprecated: boolean, message?: string) =>
    fetchJson<{ version: string; deprecated: boolean }>(
      `/v1/seeds/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}/deprecate`,
      { method: 'POST', body: JSON.stringify({ deprecated, message }) },
    ),

  deleteSeedVersion: (owner: string, name: string, version: string) =>
    fetchNoContent(
      `/v1/seeds/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`,
    ),

  deleteSeed: (owner: string, name: string) =>
    fetchNoContent(`/v1/seeds/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`),

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

  // ── OAuth consent (Peko desktop + CLI sign-in) ──────────────────────────
  describeAuthorizeRequest: (request: string) =>
    fetchJson<OAuthConsentRequest>(
      `/v1/oauth/authorize/describe?request=${encodeURIComponent(request)}`,
    ),

  decideAuthorizeRequest: (request: string, approve: boolean) =>
    fetchJson<{ redirectTo: string }>('/v1/oauth/authorize/decision', {
      method: 'POST',
      body: JSON.stringify({ request, approve }),
    }),

  describeDeviceCode: (userCode: string) =>
    fetchJson<OAuthDeviceRequest>(
      `/v1/oauth/device/describe?user_code=${encodeURIComponent(userCode)}`,
    ),

  decideDeviceCode: (userCode: string, approve: boolean) =>
    fetchJson<{ status: 'approved' | 'denied' }>('/v1/oauth/device/decision', {
      method: 'POST',
      body: JSON.stringify({ user_code: userCode, approve }),
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

  // ─────────────────────────────────────────────────────────────────────────
  // Public peko profiles — no JWT; anyone with the link can see one.
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Fetch the public profile for a peko. Used by `/peko/$owner/$pekoName`,
   * the share-link landing page. The website offers no chat; a visitor
   * opens the peko in Peko desktop and messages it over their own runtime.
   */
  publicProfile: (owner: string, pekoName: string) =>
    fetchJson<PublicProfile>(`/v1/public/pekos/${owner}/${pekoName}`),

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
    exposure: 'private' | 'public' | 'local_only',
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
  /** The peko's own avatar: an emoji or short monogram, if it has one. */
  avatar?: string | null;
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

/** An app asking to sign in, as the consent page shows it. */
export interface OAuthConsentRequest {
  client: { id: string; name: string };
  scope: string | null;
  redirectUri: string;
}

export interface OAuthDeviceRequest {
  client: { id: string; name: string };
  scope: string | null;
  userCode: string;
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
 * The Peko desktop deep link that adds a peko from its share link
 * (`peko://add-peko?url=…`, handled by peko-desktop's deep-link router).
 * The desktop adds the peko and messages it as the signed-in user.
 */
export function desktopLinkFor(shareUrl: string): string {
  return `peko://add-peko?url=${encodeURIComponent(shareUrl)}`;
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

/** One row of `GET /v1/seeds`. */
export interface SeedListItem {
  owner: string;
  name: string;
  displayName: string | null;
  description: string | null;
  avatar: string | null;
  model: string | null;
  pullCount: number;
  updatedAt: string;
}

export interface SeedList {
  items: SeedListItem[];
  total: number;
  page: number;
  perPage: number;
}

export interface SeedVersion {
  version: string;
  digest: string;
  size: number;
  createdAt: string;
  deprecated: boolean;
  deprecatedMessage: string | null;
}

/** `GET /v1/seeds/:owner/:name`. */
export interface SeedDetail {
  owner: { handle: string; displayName: string; avatarUrl: string | null };
  name: string;
  displayName: string | null;
  description: string | null;
  avatar: string | null;
  model: string | null;
  readme: string | null;
  latestVersion: string;
  /** The latest version's TOML. */
  content: string;
  versions: SeedVersion[];
  pullCount: { allTime: number; weekly: number };
  createdAt: string;
  updatedAt: string;
  createCommand: string;
  downloadUrl: string;
  webUrl: string;
}

export interface SeedPublished {
  owner: string;
  name: string;
  version: string;
  digest: string;
  downloadUrl: string;
  webUrl: string;
}

// Shape returned by GET /v1/instances for the owner. Mirrors
// `InstanceRecord` in `backend/src/services/instances.ts:106-155`.
// Local mirror — the shared package doesn't export this type yet
// because the bundle search types are the only ones the SPA needs
// from shared today.
export interface OwnedInstanceRecord {
  id: string;
  hubId: string | null;
  localId: string | null;
  type: 'principal';
  name: string;
  ownerSubject: { kind: 'user'; id: string } | null;
  runtimeId: string;
  runtimeDisplayName: string | null;
  bundleRef: string | null;
  status: 'online' | 'offline' | 'busy' | 'error';
  exposure: 'private' | 'public' | 'local_only';
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
