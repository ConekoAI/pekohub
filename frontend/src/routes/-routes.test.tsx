import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { routeTree } from '~/routeTree.gen';
import { createTestQueryClient } from '~/test/utils';

/**
 * Route-level smoke tests.
 *
 * These pin the post-pivot information architecture:
 *  - the public directory is `/pekos` (the API noun, ADR-059);
 *  - the registry surface is `/seeds` (runtime ADR-060), and the
 *    pre-pivot `/search` + `/discover` + `/bundles/*` + `/templates/*`
 *    URLs all still resolve;
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
  it('/discover → /pekos', async () => {
    const router = await loadRouter('/discover');
    expect(router.state.location.pathname).toBe('/pekos');
  });

  it('/search → /pekos, preserving the query', async () => {
    const router = await loadRouter('/search?q=ada');
    expect(router.state.location.pathname).toBe('/pekos');
    expect(router.state.location.search).toMatchObject({ q: 'ada' });
  });

  it('/bundles/<repo> → /seeds/<repo>', async () => {
    const router = await loadRouter('/bundles/peko/principals/my-peko');
    expect(router.state.location.pathname).toBe('/seeds/peko/principals/my-peko');
  });

  it('/templates/<repo> → /seeds/<repo> (ADR-060)', async () => {
    const router = await loadRouter('/templates/peko/principals/my-peko');
    expect(router.state.location.pathname).toBe('/seeds/peko/principals/my-peko');
  });

  it('bare /templates → /seeds (ADR-060)', async () => {
    const router = await loadRouter('/templates');
    expect(router.state.location.pathname).toBe('/seeds');
  });

  it('/p/<owner>/<name> → /peko/<owner>/<name>', async () => {
    const router = await loadRouter('/p/alice/foo');
    expect(router.state.location.pathname).toBe('/peko/alice/foo');
  });
});

describe('page smoke tests', () => {
  it('home renders the hero and the directory lanes', async () => {
    renderAt('/');
    expect(await screen.findByRole('heading', { name: /discover pekos/i })).toBeInTheDocument();
    expect(screen.getAllByText(/talk to them in the browser/i).length).toBeGreaterThan(0);
  });

  it('home lists public pekos from the trendings feed', async () => {
    renderAt('/');
    // The peko appears in both the trending and the fresh feed.
    expect((await screen.findAllByText('Ada')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('@testuser')).length).toBeGreaterThan(0);
  });

  it('/pekos renders the directory and its results', async () => {
    renderAt('/pekos');
    expect(await screen.findByRole('heading', { name: 'Pekos' })).toBeInTheDocument();
    expect(await screen.findByText('Ada')).toBeInTheDocument();
  });

  it('/seeds lists seeds newest first', async () => {
    renderAt('/seeds');
    expect(await screen.findByRole('heading', { name: 'Seeds' })).toBeInTheDocument();
    expect(await screen.findByText('Ada')).toBeInTheDocument();
    expect(screen.getByText('testuser/ada')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Publish a seed/ })).toBeInTheDocument();
  });

  it('/seeds/<owner>/<name> shows the download and the create command', async () => {
    renderAt('/seeds/testuser/ada');
    expect(await screen.findByRole('heading', { name: 'Ada' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Download v1\.1\.0/ })).toHaveAttribute(
      'href',
      'http://api.test/v1/seeds/testuser/ada/versions/1.1.0/seed.toml',
    );
    expect(screen.getByText('peko create my-ada -s ada.seed.toml')).toBeInTheDocument();
    // The signed-in publisher gets version actions.
    expect(screen.getByRole('button', { name: 'Undeprecate' })).toBeInTheDocument();
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

  it('/profile renders identity, runtimes and API keys', async () => {
    renderAt('/profile');
    expect(await screen.findByRole('heading', { name: 'Profile' })).toBeInTheDocument();
    expect(await screen.findByText('Registered runtimes')).toBeInTheDocument();
    expect(await screen.findByText('Test Key')).toBeInTheDocument();
  });

  it('/peko/<owner>/<name> renders the profile and opens it in Peko', async () => {
    renderAt('/peko/testuser/ada');
    expect(
      await screen.findByRole('heading', { name: 'ada' }),
    ).toBeInTheDocument();
    const open = await screen.findByRole('link', { name: /Open in Peko/ });
    expect(open.getAttribute('href')).toMatch(/^peko:\/\/add-peko\?url=.*%2Fpeko%2Ftestuser%2Fada$/);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('an unknown path renders the not-found page', async () => {
    renderAt('/definitely-not-a-route');
    expect(await screen.findByText('Nothing lives at this address')).toBeInTheDocument();
  });
});
