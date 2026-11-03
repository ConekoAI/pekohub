import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { routeTree } from '~/routeTree.gen';
import { createTestQueryClient } from '~/test/utils';

/**
 * Route-level smoke tests.
 *
 * These pin the post-pivot information architecture:
 *  - pages are IDs (hub ADR-009): `/@alice` a person, `/@alice/ada` a
 *    peko, `/alice/ada` a seed; the old `/peko/*`, `/p/*`, `/seeds/*`,
 *    `/bundles/*`, `/templates/*` links still resolve;
 *  - there is no peko directory, and the website searches seeds only:
 *    `/pekos`, `/discover` and `/search` go to `/seeds` (finding people
 *    and pekos by ID is the desktop's job);
 *  - every page mounts without throwing.
 *
 * A page that renders here but throws in the browser is caught by the
 * root error boundary instead, so "renders the heading" is a real
 * assertion about wiring, queries and the route tree — not decoration.
 */

async function loadRouter(path: string) {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  return router;
}

function renderAt(path: string) {
  const queryClient = createTestQueryClient();
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
    context: { queryClient },
  });

  const result = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );

  return { ...result, router };
}

describe('legacy URL redirects', () => {
  it('/discover → /seeds', async () => {
    const router = await loadRouter('/discover');
    expect(router.state.location.pathname).toBe('/seeds');
  });

  it('/pekos and /search → /seeds, preserving the query', async () => {
    for (const from of ['/pekos?q=ada', '/search?q=ada']) {
      const router = await loadRouter(from);
      expect(router.state.location.pathname).toBe('/seeds');
      expect(router.state.location.search).toMatchObject({ q: 'ada' });
    }
  });

  it('/seeds/<owner>/<name> → /<owner>/<name>, the seed ID', async () => {
    const router = await loadRouter('/seeds/alice/ada');
    expect(router.state.location.pathname).toBe('/alice/ada');
  });

  it('/bundles/<owner>/<name> and /templates/<owner>/<name> → /<owner>/<name>', async () => {
    expect((await loadRouter('/bundles/alice/ada')).state.location.pathname).toBe('/alice/ada');
    expect((await loadRouter('/templates/alice/ada')).state.location.pathname).toBe('/alice/ada');
  });

  it('bare /templates → /seeds (ADR-060)', async () => {
    const router = await loadRouter('/templates');
    expect(router.state.location.pathname).toBe('/seeds');
  });

  it('/p/<owner>/<name> and /peko/<owner>/<name> → /@<owner>/<name>', async () => {
    expect((await loadRouter('/p/alice/foo')).state.location.pathname).toBe('/@alice/foo');
    expect((await loadRouter('/peko/alice/foo')).state.location.pathname).toBe('/@alice/foo');
  });
});

describe('page smoke tests', () => {
  it('home leads to the desktop download and the seeds', async () => {
    renderAt('/');
    expect(await screen.findByRole('heading', { name: /an ai of your own/i })).toBeInTheDocument();
    const downloads = screen.getAllByRole('link', { name: /download peko/i });
    expect(downloads.length).toBeGreaterThan(0);
    for (const link of downloads) expect(link).toHaveAttribute('href', '/download');
    for (const link of screen.getAllByRole('link', { name: /browse seeds/i })) expect(link).toHaveAttribute('href', '/seeds');
    // The website offers no chat, and says nothing that suggests it.
    expect(screen.queryByText(/in the browser/i)).not.toBeInTheDocument();
  });

  it('/download offers every desktop platform and the CLI', async () => {
    renderAt('/download');
    expect(await screen.findByRole('heading', { name: 'Download Peko' })).toBeInTheDocument();
    for (const id of ['macos', 'windows', 'linux']) {
      expect(screen.getByTestId(`download-${id}`)).toHaveAttribute(
        'href',
        'https://github.com/ConekoAI/peko-desktop/releases/latest',
      );
    }
    expect(screen.getByText(/install\.sh \| bash/)).toBeInTheDocument();
  });

  it('/terms and /privacy render', async () => {
    renderAt('/terms');
    expect(await screen.findByRole('heading', { name: 'Terms' })).toBeInTheDocument();
    renderAt('/privacy');
    expect(await screen.findByRole('heading', { name: 'Privacy' })).toBeInTheDocument();
  });

  it('home shows seeds and no pekos (hub ADR-009)', async () => {
    renderAt('/');
    expect(await screen.findByText('testuser/ada')).toBeInTheDocument();
    expect(screen.queryByText(/made public/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^pekos$/i })).not.toBeInTheDocument();
    // The one search box on the page searches seeds; no one is looked up by ID.
    expect(screen.getByRole('textbox', { name: 'Search' })).toHaveAttribute('placeholder', 'Search seeds');
    expect(screen.queryByText(/someone's id/i)).not.toBeInTheDocument();
  });

  it('/seeds?q= searches seeds by text', async () => {
    renderAt('/seeds?q=notes');
    const card = await screen.findByRole('link', { name: /my-peko/ });
    expect(card).toHaveAttribute('href', '/testuser/my-peko');
  });

  it('/seeds?q=@handle finds that person\'s seeds, never the person', async () => {
    renderAt('/seeds?q=%40testuser');
    expect(await screen.findByRole('link', { name: /my-peko/ })).toBeInTheDocument();
    expect(screen.queryByText('person')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Test User/ })).not.toBeInTheDocument();
  });

  it('/@<handle> shows the person and their seeds, not their pekos', async () => {
    renderAt('/@testuser');
    expect(await screen.findByRole('heading', { name: 'Test User' })).toBeInTheDocument();
    expect(screen.getByText(/^@testuser · /)).toBeInTheDocument();
    expect(await screen.findByText('testuser/ada')).toBeInTheDocument();
    expect(screen.queryByText(/Open in Peko/)).not.toBeInTheDocument();
  });

  it('/@<unknown handle> is not found', async () => {
    renderAt('/@nobody');
    expect(await screen.findByText('Nothing lives at this address')).toBeInTheDocument();
  });

  it('/seeds lists seeds newest first', async () => {
    renderAt('/seeds');
    expect(await screen.findByRole('heading', { name: 'Seeds' })).toBeInTheDocument();
    expect(await screen.findByText('Ada')).toBeInTheDocument();
    expect(screen.getByText('testuser/ada')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Publish a seed/ })).toBeInTheDocument();
  });

  it('/<owner>/<name> shows the seed: the download and the create command', async () => {
    renderAt('/testuser/ada');
    expect(await screen.findByRole('heading', { name: 'Ada' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Download v1\.1\.0/ })).toHaveAttribute(
      'href',
      'http://api.test/v1/seeds/testuser/ada/versions/1.1.0/seed.toml',
    );
    expect(screen.getByText('peko create my-ada -s ada.seed.toml')).toBeInTheDocument();
    // The signed-in publisher gets version actions.
    expect(screen.getByRole('button', { name: 'Undeprecate' })).toBeInTheDocument();
  });

  it('/<owner>/<name>@<version> offers that version', async () => {
    renderAt('/testuser/ada@1.0.0');
    expect(await screen.findByRole('link', { name: /Download v1\.0\.0/ })).toHaveAttribute(
      'href',
      'http://api.test/v1/seeds/testuser/ada/versions/1.0.0/seed.toml',
    );
  });

  it('/seeds/<legacy multi-segment path> is not found', async () => {
    renderAt('/seeds/peko/principals/my-peko');
    expect(await screen.findByText('Nothing lives at this address')).toBeInTheDocument();
  });

  it('/dashboard renders the owner console', async () => {
    renderAt('/dashboard');
    expect(await screen.findByRole('heading', { name: 'Your pekos' })).toBeInTheDocument();
    expect(await screen.findByText('Ada')).toBeInTheDocument();
  });

  it('/profile is the account: identity, signed-in apps, API keys', async () => {
    renderAt('/profile');
    expect(await screen.findByRole('heading', { name: 'Account' })).toBeInTheDocument();
    const app = await screen.findByTestId('signed-in-app');
    expect(within(app).getByText('Peko desktop')).toBeInTheDocument();
    expect(within(app).getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(await screen.findByText('Test Key')).toBeInTheDocument();
  });

  it('/dashboard/runtimes lists your computers, connected or not', async () => {
    renderAt('/dashboard/runtimes');
    expect(await screen.findByRole('heading', { name: 'Runtimes' })).toBeInTheDocument();
    expect(await screen.findByText('workstation')).toBeInTheDocument();
    expect(screen.getByText('connected')).toBeInTheDocument();
    expect(screen.getByText('2 pekos online')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unregister' })).toBeInTheDocument();
  });

  it('/dashboard/seeds lists the seeds you published', async () => {
    renderAt('/dashboard/seeds');
    expect(await screen.findByRole('heading', { name: 'Your seeds' })).toBeInTheDocument();
    expect(await screen.findByText('Ada')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Publish a seed/ })).toHaveAttribute('href', '/seeds/new');
  });

  it('/@<owner>/<name> renders the peko and opens it in Peko', async () => {
    renderAt('/@testuser/ada');
    expect(
      await screen.findByRole('heading', { name: 'ada' }),
    ).toBeInTheDocument();
    const open = await screen.findByRole('link', { name: /Open in Peko/ });
    expect(open.getAttribute('href')).toMatch(/^peko:\/\/add-peko\?url=.*%2F%40testuser%2Fada$/);
    expect(screen.getByText('@testuser/ada')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('an unknown path renders the not-found page', async () => {
    renderAt('/definitely-not-a-route');
    expect(await screen.findByText('Nothing lives at this address')).toBeInTheDocument();
  });
});
