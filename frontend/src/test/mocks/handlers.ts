import { http, HttpResponse } from 'msw';

/**
 * MSW handlers for the frontend test suite.
 *
 * `test/setup.ts` runs MSW with `onUnhandledRequest: 'error'`, so every
 * endpoint a rendered page touches must be represented here. Shapes
 * mirror the real backend responses — see `packages/shared/src/schemas.ts`
 * and `backend/src/routes/api/instances.ts`.
 */

const DISCOVERY_HIT = {
  id: 'inst-1',
  publicName: 'Ada',
  description: 'A research peko that reads papers and keeps notes.',
  ownerName: 'Test User',
  ownerNamespace: 'testuser',
  ownerAvatarUrl: null,
  category: 'research',
  tags: ['papers', 'notes'],
  status: 'online',
  publishedAt: new Date().toISOString(),
  featured: false,
};

function templateDetail(namespace: string, name: string) {
  const version = {
    version: '1.0.0',
    digest: 'sha256:abc123def4567890',
    size: 2048,
    createdAt: new Date().toISOString(),
    deprecated: false,
    deprecatedMessage: null,
  };

  return {
    namespace,
    name,
    versions: [version],
    metadata: {
      name,
      description: 'A test template',
      author: 'Test Author',
      license: 'MIT',
      tags: ['test'],
      bundleType: 'principal',
      homepage: null,
      repository: null,
      readme: '# Test template\n\nGround it with `peko create -f`.',
      version: '1.0.0',
      deprecated: false,
    },
    readme: '# Test template\n\nGround it with `peko create -f`.',
    pullCount: { daily: 5, weekly: 20, monthly: 100, allTime: 500 },
    installCommand: `peko pull pekohub.ai/${namespace}/${name}:1.0.0`,
  };
}

/** Split `/v1/bundles/<repo>[/suffix]` into namespace + name. */
function repoFromUrl(url: string, suffix = ''): { namespace: string; name: string } {
  const path = new URL(url).pathname;
  const repo = path.replace(/^\/v1\/bundles\//, '').replace(new RegExp(`${suffix}$`), '');
  const segments = repo.split('/').filter(Boolean);
  const name = segments[segments.length - 1] ?? '';
  return { namespace: segments.slice(0, -1).join('/'), name };
}

export const handlers = [
  // ── Auth ────────────────────────────────────────────────────────────────
  http.get('/v1/auth/me', () =>
    HttpResponse.json({
      id: 'user-1',
      namespace: 'testuser',
      displayName: 'Test User',
      email: 'test@example.com',
      avatarUrl: 'https://example.com/avatar.png',
      createdAt: new Date('2026-01-01').toISOString(),
    }),
  ),

  http.post('/v1/auth/logout', () => HttpResponse.json({ success: true })),

  // ── Search (template directory with a query) ────────────────────────────
  http.get('/v1/search', ({ request }) => {
    const url = new URL(request.url);
    return HttpResponse.json({
      items: [
        {
          namespace: 'peko/principals',
          name: 'my-peko',
          version: '1.0.0',
          description: 'A test peko template',
          author: 'Test Author',
          bundleType: 'principal',
          tags: ['test', 'peko'],
          pullCount: 42,
          updatedAt: new Date().toISOString(),
        },
      ],
      total: 1,
      page: Number(url.searchParams.get('page') ?? 1),
      perPage: Number(url.searchParams.get('perPage') ?? 20),
      totalPages: 1,
    });
  }),

  // ── OCI catalog (template directory without a query) ────────────────────
  // One path per lane class so the retired-lane filter is exercised: a
  // current template, a pre-ADR-005 row, and a retired lane.
  http.get('/v2/_catalog', () =>
    HttpResponse.json({
      repositories: [
        'peko/principals/my-peko',
        'legacy-user/old-peko',
        'peko/extensions/retired-thing',
      ],
    }),
  ),

  // ── Template detail (multi-segment namespace) ───────────────────────────
  // Path-to-regexp's `*` matches a single segment, so multi-segment
  // repository paths (`peko/principals/foo`) need a regexp matcher.
  http.get(/\/v1\/bundles\/.+\/versions$/, ({ request }) => {
    const repo = repoFromUrl(request.url, '/versions');
    return HttpResponse.json({
      namespace: repo.namespace,
      name: repo.name,
      versions: templateDetail(repo.namespace, repo.name).versions,
    });
  }),

  http.get(/\/v1\/bundles\/.+/, ({ request }) => {
    const repo = repoFromUrl(request.url);
    return HttpResponse.json(templateDetail(repo.namespace, repo.name));
  }),

  // ── Discovery ───────────────────────────────────────────────────────────
  http.get('/v1/discovery/search', () =>
    HttpResponse.json({ hits: [DISCOVERY_HIT], total: 1, page: 1 }),
  ),

  http.get('/v1/discovery/feed/:feed', ({ params }) =>
    HttpResponse.json({
      hits: [DISCOVERY_HIT],
      total: 1,
      page: 1,
      feed: String(params.feed),
    }),
  ),

  // ── Owner dashboard ─────────────────────────────────────────────────────
  http.get('/v1/instances', () =>
    HttpResponse.json({
      data: [
        {
          id: 'inst-1',
          type: 'principal',
          name: 'ada',
          ownerSubject: { kind: 'user', id: 'user-1' },
          runtimeId: 'did:key:z6MkRuntime',
          runtimeDisplayName: 'workstation',
          bundleRef: null,
          status: 'online',
          exposure: 'public',
          lastSeenAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          capabilities: ['fs', 'web'],
          metadata: {},
          publicName: 'Ada',
          description: 'A research peko.',
          tags: ['papers'],
          category: 'research',
          tosRequired: false,
          tosText: null,
          dailyQuota: null,
          weeklyQuota: null,
          publishedAt: new Date().toISOString(),
          featured: false,
          monetization: {
            enabled: false,
            pricingModel: null,
            priceCents: null,
            stripeProductId: null,
          },
          principalDid: 'did:key:z6MkPeko',
        },
      ],
      total: 1,
    }),
  ),

  http.get('/v1/me/accessible-pekos', () => HttpResponse.json({ pekos: [] })),

  http.get('/v1/public/pekos/:owner/:pekoName', ({ params }) =>
    HttpResponse.json({
      liveInstance: {
        id: 'inst-1',
        publicName: String(params.pekoName),
        description: 'A research peko that reads papers and keeps notes.',
        owner: {
          id: 'user-1',
          name: 'Test User',
          avatarUrl: null,
        },
        capabilities: ['fs', 'web'],
        status: 'online',
        tosRequired: false,
        tosText: null,
      },
    }),
  ),

  http.get('/v1/runtimes', () =>
    HttpResponse.json({
      runtimes: [
        {
          id: 1,
          runtimeDid: 'did:key:z6MkRuntime',
          ownerId: 'user-1',
          displayName: 'workstation',
          lastSeenAt: new Date().toISOString(),
          createdAt: new Date('2026-01-01').toISOString(),
        },
      ],
    }),
  ),

  // ── API keys ────────────────────────────────────────────────────────────
  http.get('/v1/auth/api-keys', () =>
    HttpResponse.json({
      keys: [
        {
          id: 1,
          name: 'Test Key',
          prefix: 'pkr_abc123',
          createdAt: new Date().toISOString(),
          lastUsedAt: null,
        },
      ],
    }),
  ),

  http.post('/v1/auth/api-keys', async ({ request }) => {
    const body = (await request.json()) as { name: string };
    return HttpResponse.json({
      id: 2,
      name: body.name,
      prefix: 'pkr_xyz789',
      key: 'pkr_xyz789fullkey',
      createdAt: new Date().toISOString(),
    });
  }),
];
