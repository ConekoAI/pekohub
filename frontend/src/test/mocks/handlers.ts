import { http, HttpResponse } from 'msw';

export const handlers = [
  // Auth
  http.get('/api/v1/auth/me', () => {
    return HttpResponse.json({
      id: 1,
      namespace: 'testuser',
      displayName: 'Test User',
      email: 'test@example.com',
      avatarUrl: 'https://example.com/avatar.png',
    });
  }),

  http.post('/api/v1/auth/logout', () => {
    return HttpResponse.json({ success: true });
  }),

  // Search
  http.get('/api/v1/search', ({ request }) => {
    const url = new URL(request.url);

    return HttpResponse.json({
      hits: [
        {
          namespace: 'acme',
          name: 'my-agent',
          version: 'v1.0.0',
          description: 'A test agent bundle',
          author: 'Test Author',
          bundleType: 'agent',
          tags: ['test', 'agent'],
          pullCount: 42,
          starCount: 10,
          updatedAt: new Date().toISOString(),
        },
      ],
      total: 1,
      page: Number(url.searchParams.get('page') ?? 1),
      perPage: Number(url.searchParams.get('perPage') ?? 20),
    });
  }),

  // Bundles
  http.get('/api/v1/bundles/:namespace/:name', ({ params }) => {
    return HttpResponse.json({
      namespace: params.namespace,
      name: params.name,
      versions: [
        {
          version: 'v1.0.0',
          digest: 'sha256:abc123',
          size: 1024,
          createdAt: new Date().toISOString(),
          deprecated: false,
          deprecatedMessage: null,
        },
      ],
      metadata: {
        name: params.name,
        description: 'A test bundle',
        author: 'Test Author',
        license: 'MIT',
        tags: ['test'],
        categories: [],
        bundleType: 'agent',
        extensionType: undefined,
        modelProviders: [],
        requiredMcpServers: [],
        homepage: undefined,
        repository: undefined,
        readme: undefined,
        version: 'v1.0.0',
        deprecated: false,
        forkedFrom: undefined,
      },
      readme: '# Test Bundle\n\nThis is a test.',
      pullCount: {
        daily: 5,
        weekly: 20,
        monthly: 100,
        allTime: 500,
      },
      installCommand: `peko agent install ${params.namespace}/${params.name}:v1.0.0`,
    });
  }),

  http.get('/api/v1/bundles/:namespace/:name/versions', ({ params }) => {
    return HttpResponse.json({
      namespace: params.namespace,
      name: params.name,
      versions: [
        {
          version: 'v1.0.0',
          digest: 'sha256:abc123',
          size: 1024,
          createdAt: new Date().toISOString(),
          deprecated: false,
          deprecatedMessage: null,
        },
        {
          version: 'v2.0.0',
          digest: 'sha256:def456',
          size: 2048,
          createdAt: new Date().toISOString(),
          deprecated: false,
          deprecatedMessage: null,
        },
      ],
    });
  }),

  // API Keys
  http.get('/api/v1/auth/api-keys', () => {
    return HttpResponse.json({
      keys: [
        {
          id: 1,
          name: 'Test Key',
          prefix: 'ph_abc123',
          createdAt: new Date().toISOString(),
          lastUsedAt: null,
        },
      ],
    });
  }),

  http.post('/api/v1/auth/api-keys', async ({ request }) => {
    const body = (await request.json()) as { name: string };
    return HttpResponse.json({
      id: 2,
      name: body.name,
      prefix: 'ph_xyz789',
      key: 'ph_xyz789fullkey',
      createdAt: new Date().toISOString(),
    });
  }),
];
