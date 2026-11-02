import { http, HttpResponse } from 'msw';

/**
 * MSW handlers for the frontend test suite.
 *
 * `test/setup.ts` runs MSW with `onUnhandledRequest: 'error'`, so every
 * endpoint a rendered page touches must be represented here. Shapes
 * mirror the real backend responses — see `packages/shared/src/schemas.ts`
 * and `backend/src/routes/api/instances.ts`.
 */

const SEED_TOML = 'name = "ada"\npreferred_model_id = "claude-opus-5-5"\n\n[identity]\ndisplay_name = "Ada"\n';

function seedDetail(owner: string, name: string) {
  return {
    owner: { handle: owner, displayName: 'Test User', avatarUrl: null },
    name,
    displayName: 'Ada',
    description: 'Reads papers and keeps notes',
    avatar: '🦉',
    model: 'claude-opus-5-5',
    readme: '## About\nA research partner.',
    latestVersion: '1.1.0',
    content: SEED_TOML,
    versions: [
      { version: '1.1.0', digest: `sha256:${'b'.repeat(64)}`, size: 80, createdAt: new Date('2026-10-02').toISOString(), deprecated: false, deprecatedMessage: null },
      { version: '1.0.0', digest: `sha256:${'a'.repeat(64)}`, size: 78, createdAt: new Date('2026-10-01').toISOString(), deprecated: true, deprecatedMessage: 'old persona' },
    ],
    pullCount: { allTime: 42, weekly: 3 },
    createdAt: new Date('2026-10-01').toISOString(),
    updatedAt: new Date('2026-10-02').toISOString(),
    createCommand: `peko create my-${name} -s ${name}.seed.toml`,
    downloadUrl: `http://api.test/v1/seeds/${owner}/${name}/versions/1.1.0/seed.toml`,
    webUrl: `http://web.test/${owner}/${name}`,
  };
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

  // OAuth consent (desktop + CLI sign-in)
  http.get('/v1/oauth/authorize/describe', ({ request }) =>
    new URL(request.url).searchParams.get('request') === 'expired'
      ? HttpResponse.json({ error: 'expired' }, { status: 400 })
      : HttpResponse.json({
          client: { id: 'peko-desktop', name: 'Peko desktop' },
          scope: null,
          redirectUri: 'http://localhost:19876/callback',
        }),
  ),
  http.get('/v1/oauth/device/describe', ({ request }) =>
    new URL(request.url).searchParams.get('user_code') === 'BCDF-GHJK'
      ? HttpResponse.json({
          client: { id: 'peko-cli', name: 'Peko CLI' },
          scope: null,
          userCode: 'BCDF-GHJK',
        })
      : HttpResponse.json({ error: 'not found' }, { status: 404 }),
  ),
  http.post('/v1/oauth/device/decision', async ({ request }) => {
    const body = (await request.json()) as { approve: boolean };
    return HttpResponse.json({ status: body.approve ? 'approved' : 'denied' });
  }),

  // ── Search: exact IDs, then seeds (hub ADR-009) ─────────────────────
  http.get('/v1/search', ({ request }) => {
    const url = new URL(request.url);
    const q = url.searchParams.get('q') ?? '';
    if (q === '@testuser') {
      return HttpResponse.json({
        items: [], total: 0, page: 1, perPage: 24, totalPages: 0, queryKind: 'person',
        exact: [{ kind: 'person', id: '@testuser', handle: 'testuser', displayName: 'Test User', avatarUrl: null, url: 'http://web.test/@testuser' }],
      });
    }
    if (q === '@testuser/ada') {
      return HttpResponse.json({
        items: [], total: 0, page: 1, perPage: 24, totalPages: 0, queryKind: 'peko',
        exact: [{ kind: 'peko', id: '@testuser/ada', owner: 'testuser', name: 'ada', displayName: 'Ada', description: 'A research peko.', avatar: null, status: 'online', url: 'http://web.test/@testuser/ada' }],
      });
    }
    if (q.startsWith('@')) {
      return HttpResponse.json({ items: [], total: 0, page: 1, perPage: 24, totalPages: 0, queryKind: 'peko', exact: [] });
    }
    return HttpResponse.json({
      queryKind: 'text',
      exact: [],
      items: [
        {
          namespace: 'testuser',
          name: 'my-peko',
          version: '1.0.0',
          description: 'A test peko seed',
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

  // ── Seeds ───────────────────────────────────────────────────────────
  http.get('/v1/seeds', () =>
    HttpResponse.json({
      items: [
        {
          owner: 'testuser',
          name: 'ada',
          displayName: 'Ada',
          description: 'Reads papers and keeps notes',
          avatar: '🦉',
          model: 'claude-opus-5-5',
          pullCount: 42,
          updatedAt: new Date().toISOString(),
        },
      ],
      total: 1,
      page: 1,
      perPage: 24,
    }),
  ),
  http.get('/v1/seeds/:owner/:name', ({ params }) =>
    params.name === 'missing'
      ? HttpResponse.json({ error: 'Seed not found' }, { status: 404 })
      : HttpResponse.json(seedDetail(String(params.owner), String(params.name))),
  ),
  http.post('/v1/seeds', async ({ request }) => {
    const body = (await request.json()) as { seed: string; version: string };
    if (body.seed.includes('did =')) {
      return HttpResponse.json({ error: "A seed can't carry `did`" }, { status: 422 });
    }
    return HttpResponse.json(
      { owner: 'testuser', name: 'ada', version: body.version, digest: 'sha256:x', downloadUrl: '', webUrl: '' },
      { status: 201 },
    );
  }),

  // ── Owner dashboard ─────────────────────────────────────────────────────
  http.get('/v1/instances', () =>
    HttpResponse.json({
      data: [
        {
          id: 'inst-1',
          hubId: '156f1a95-d977-4c4a-979e-8ed4848ae6eb',
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

  // ── People, by exact handle ─────────────────────────────────────────
  http.get('/v1/people/:handle', ({ params }) =>
    params.handle === 'testuser'
      ? HttpResponse.json({
          kind: 'person',
          id: '@testuser',
          handle: 'testuser',
          displayName: 'Test User',
          avatarUrl: null,
          url: 'http://web.test/@testuser',
          joinedAt: new Date('2026-01-01').toISOString(),
        })
      : HttpResponse.json({ error: 'No one has that handle' }, { status: 404 }),
  ),

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
          connected: true,
          pekoCount: 2,
        },
      ],
    }),
  ),
  http.delete('/v1/runtimes/:did', () => new HttpResponse(null, { status: 204 })),
  http.get('/v1/auth/apps', () =>
    HttpResponse.json({
      apps: [
        {
          clientId: 'peko-desktop',
          name: 'Peko desktop',
          sessions: 1,
          lastActiveAt: new Date().toISOString(),
          devices: ['Peko/0.1 (macOS)'],
        },
      ],
    }),
  ),
  http.delete('/v1/auth/apps/:clientId', () => new HttpResponse(null, { status: 204 })),
  http.post('/v1/principals/by-hub-id/:hubId/transfer', async ({ request }) => {
    const body = (await request.json()) as { ownerHandle: string };
    return body.ownerHandle === 'nobody'
      ? HttpResponse.json({ error: 'No PekoHub user is called @nobody' }, { status: 422 })
      : new HttpResponse(null, { status: 204 });
  }),

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
