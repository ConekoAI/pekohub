import type { SearchQuery, SearchResponse, UserProfile, PublicProfile } from '@pekohub/shared';

declare const __API_BASE__: string;
export const API_BASE = typeof __API_BASE__ !== 'undefined' ? __API_BASE__ : '';

const TOKEN_KEY = 'pekohub_token';

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

/** One refresh at a time: concurrent 401s share it. */
function refreshAccessToken(): Promise<string> {
  refreshPromise ??= doRefresh().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

/**
 * Request headers. `Content-Type` only rides a request with a body: on a
 * cross-origin GET it would force a CORS preflight, a second round trip
 * before every read.
 */
function requestHeaders(token: string | null, options?: RequestInit): HeadersInit {
  return {
    ...(options?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...options?.headers,
  };
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const token = getAuthToken();
  const response = await fetch(`${API_BASE}${url}`, {
    ...options,
    credentials: 'include',
    headers: requestHeaders(token, options),
  });

  if (response.status === 401 && !url.includes('/auth/refresh') && !url.includes('/auth/me')) {
    try {
      const newToken = await refreshAccessToken();
      // Retry original request with new token
      const retryResponse = await fetch(`${API_BASE}${url}`, {
        ...options,
        credentials: 'include',
        headers: requestHeaders(newToken, options),
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
async function fetchNoContent(url: string, method = 'DELETE', body?: unknown): Promise<void> {
  const token = getAuthToken();
  const response = await fetch(`${API_BASE}${url}`, {
    method,
    credentials: 'include',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    throw new ApiError(response.status, error.error ?? `HTTP ${response.status}`, error);
  }
}

/** A group as its page shows it (runtime ADR-092 D5). */
export interface PublicGroup {
  id: string;
  name: string;
  visibility: 'invite_only' | 'public';
  owner: { kind: 'peko' | 'person'; name: string | null; handle: string | null };
  homeRuntime: string;
  channelId: string;
  homeOnline: boolean;
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

  // ── Groups (runtime ADR-092 D5) ──────────────────────────────────────────
  getGroup: (id: string, invite?: string) =>
    fetchJson<PublicGroup>(
      `/v1/groups/${encodeURIComponent(id)}${invite ? `?invite=${encodeURIComponent(invite)}` : ''}`,
    ),

  // ── Seeds (the registry) ────────────────────────────────────────────────
  listSeeds: (opts?: { page?: number; perPage?: number; owner?: string }) => {
    const params = new URLSearchParams();
    if (opts?.page) params.set('page', String(opts.page));
    if (opts?.perPage) params.set('perPage', String(opts.perPage));
    if (opts?.owner) params.set('owner', opts.owner);
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

  /**
   * Who is signed in, or `null`. With no saved token no one is, and no
   * request is made — the header shows "Sign in" at once. An expired token
   * is refreshed from the refresh cookie once; if that fails, the visitor
   * is signed out (not sent home, as other calls are).
   */
  getMe: async (): Promise<UserProfile | null> => {
    if (!getAuthToken()) return null;
    try {
      return await fetchJson<UserProfile>('/v1/auth/me');
    } catch (error) {
      if (!isApiError(error) || error.status !== 401) throw error;
    }
    try {
      await refreshAccessToken();
      return await fetchJson<UserProfile>('/v1/auth/me');
    } catch {
      clearAuthToken();
      return null;
    }
  },

  /**
   * Runtimes owned by the caller (ADR-032/058). Every peko is hosted by
   * exactly one runtime, so this is the owner's "where do my pekos
   * live" view. Requires a JWT.
   */
  listRuntimes: () => fetchJson<{ runtimes: RuntimeRecord[] }>('/v1/runtimes'),

  /** Unregister a runtime: its pekos leave the directory and its tunnel closes. */
  unregisterRuntime: (runtimeDid: string) =>
    fetchNoContent(`/v1/runtimes/${encodeURIComponent(runtimeDid)}`),

  /** One publisher's seeds (the owner console's list). */
  listSeedsBy: (owner: string) =>
    fetchJson<SeedList>(`/v1/seeds?owner=${encodeURIComponent(owner)}&perPage=100`),

  listSignedInApps: () => fetchJson<{ apps: SignedInApp[] }>('/v1/auth/apps'),

  /** Sign an app (Peko desktop, the CLI) out everywhere. */
  signOutApp: (clientId: string) => fetchNoContent(`/v1/auth/apps/${encodeURIComponent(clientId)}`),

  /** Offer a peko to another PekoHub account; it moves when they accept (ADR-081 D4). */
  transferPeko: (hubId: string, ownerHandle: string) =>
    fetchJson<{ status: 'offered' }>(`/v1/principals/by-hub-id/${encodeURIComponent(hubId)}/transfer`, {
      method: 'POST',
      body: JSON.stringify({ ownerHandle }),
    }),

  /** Open transfer offers to and from the signed-in account. */
  listTransfers: () => fetchJson<{ transfers: PekoTransfer[] }>('/v1/me/transfers'),

  /** Take a peko offered to you; its runtime is told. */
  acceptTransfer: (hubId: string) =>
    fetchNoContent(`/v1/principals/by-hub-id/${encodeURIComponent(hubId)}/transfer/accept`, 'POST', {}),

  /** Decline an offer to you, or withdraw one you made. */
  withdrawTransfer: (hubId: string) =>
    fetchNoContent(`/v1/principals/by-hub-id/${encodeURIComponent(hubId)}/transfer`),

  logout: () =>
    fetchJson<void>('/v1/auth/logout', { method: 'POST' }).finally(() => {
      clearAuthToken();
    }),

  // ─────────────────────────────────────────────────────────────────────────
  // Public peko profiles — no JWT; anyone with the link can see one.
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Fetch the public profile for a peko by its ID, `@owner/name`. Used by
   * `/@owner/name`, the share-link landing page. The website offers no chat; a visitor
   * opens the peko in Peko desktop and messages it over their own runtime.
   */
  publicProfile: (owner: string, pekoName: string) =>
    fetchJson<PublicProfile>(`/v1/public/pekos/${encodeURIComponent(owner)}/${encodeURIComponent(pekoName)}`),

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
  // People — found by exact handle (hub ADR-009). A person's page shows
  // their profile and published seeds, never their pekos.
  // ─────────────────────────────────────────────────────────────────────────

  person: (handle: string) => fetchJson<PersonProfile>(`/v1/people/${encodeURIComponent(handle)}`),

  // ─────────────────────────────────────────────────────────────────────────
  // Trust & safety (gap map B2/B3). Anyone signed in reports; moderators
  // work the queue on `/admin`.
  // ─────────────────────────────────────────────────────────────────────────

  /** Report a seed `owner/name[@version]`, a peko `@owner/name`, a person `@handle`, or a group ID. */
  fileReport: (body: { target: string; reason: ReportReason; note?: string }) =>
    fetchJson<{ id: string; status: ReportStatus; duplicate: boolean }>('/v1/reports', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  listReports: (status: ReportStatus) =>
    fetchJson<{ reports: ModerationReport[]; total: number }>(`/v1/admin/reports?status=${status}`),

  resolveReport: (id: string, status: ReportStatus, resolution?: string) =>
    fetchJson<{ id: string; status: ReportStatus }>(`/v1/admin/reports/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ status, resolution }),
    }),

  hideSeed: (owner: string, name: string, hidden: boolean, action: ModerationAction = {}) =>
    fetchJson<{ hidden: boolean }>(
      `/v1/admin/seeds/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/hide`,
      { method: 'POST', body: JSON.stringify({ hidden, ...action }) },
    ),

  yankSeedVersion: (owner: string, name: string, version: string, yanked: boolean, action: ModerationAction = {}) =>
    fetchJson<{ version: string; yanked: boolean }>(
      `/v1/admin/seeds/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}/yank`,
      { method: 'POST', body: JSON.stringify({ yanked, ...action }) },
    ),

  takeDownPeko: (hubId: string, takenDown: boolean, action: ModerationAction = {}) =>
    fetchJson<{ takenDown: boolean; tunnelNotified: boolean }>(
      `/v1/admin/pekos/${encodeURIComponent(hubId)}/takedown`,
      { method: 'POST', body: JSON.stringify({ takenDown, ...action }) },
    ),

  suspendAccount: (account: string, suspended: boolean, action: ModerationAction = {}) =>
    fetchJson<{ suspended: boolean; runtimesClosed: number }>(
      `/v1/admin/users/${encodeURIComponent(account)}/suspend`,
      { method: 'POST', body: JSON.stringify({ suspended, ...action }) },
    ),
};

export const REPORT_REASONS = [
  { value: 'spam', label: 'Spam' },
  { value: 'harassment', label: 'Harassment or hate' },
  { value: 'illegal', label: 'Illegal content' },
  { value: 'impersonation', label: 'Impersonation' },
  { value: 'malicious', label: 'Malware or a scam' },
  { value: 'other', label: 'Something else' },
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number]['value'];
export type ReportStatus = 'open' | 'actioned' | 'dismissed';

/** Why a moderator acted, and the report it answers (closed as actioned). */
export interface ModerationAction {
  reason?: string;
  reportId?: string;
}

/** One report in the moderation queue (`GET /v1/admin/reports`). */
export interface ModerationReport {
  id: string;
  targetKind: 'seed' | 'peko' | 'person' | 'group';
  /** `alice/ada@1.0.0`, `@alice/ada`, `@alice`, or a group ID. */
  target: string;
  /** A peko's Hub ID, a person's or group's ID; null for a seed. */
  targetId: string | null;
  reason: ReportReason;
  note: string | null;
  status: ReportStatus;
  createdAt: string;
  reporter: { handle: string } | null;
  account: { id: string; handle: string; suspended: boolean } | null;
  targetRemoved: boolean;
  resolvedBy: { handle: string } | null;
  resolvedAt: string | null;
  resolution: string | null;
}

/** `GET /v1/people/:handle`: a person's page. */
export interface PersonProfile {
  kind: 'person';
  /** `@alice` */
  id: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  url: string;
  joinedAt: string;
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
  /** Its tunnel is up right now. */
  connected?: boolean;
  /** Pekos it has put online. */
  pekoCount?: number;
}

/** An app signed in to the account (`GET /v1/auth/apps`). */
/** An open offer to hand a peko from one account to another. */
export interface PekoTransfer {
  hubId: string;
  direction: 'incoming' | 'outgoing';
  pekoName: string;
  pekoAvatar: string | null;
  /** The account on the other side: who offers it, or who it is offered to. */
  otherHandle: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface SignedInApp {
  clientId: string;
  name: string;
  sessions: number;
  lastActiveAt: string;
  devices: string[];
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
