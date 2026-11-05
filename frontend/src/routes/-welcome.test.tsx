import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { routeTree } from '~/routeTree.gen';
import { createTestQueryClient } from '~/test/utils';
import { server } from '~/test/mocks/server';

const me = (overrides: Record<string, unknown> = {}) => ({
  id: 'user-1',
  namespace: 'john-smith1987',
  displayName: 'John Smith',
  createdAt: new Date('2026-11-05').toISOString(),
  handleChosen: false,
  handleLocked: false,
  ...overrides,
});

function renderAt(path: string) {
  const queryClient = createTestQueryClient();
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
    context: { queryClient },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe('/welcome (choose your handle)', () => {
  it('offers the suggested handle and keeps it', async () => {
    let chosen: unknown = null;
    server.use(
      http.get('/v1/auth/me', () => HttpResponse.json(me())),
      http.put('/v1/auth/handle', async ({ request }) => {
        chosen = await request.json();
        return HttpResponse.json({ namespace: 'john-smith1987', token: 't2', handleChosen: true, handleLocked: false });
      }),
    );
    const router = renderAt('/welcome?next=/authorize');

    expect(await screen.findByRole('heading', { name: 'Choose your handle' })).toBeInTheDocument();
    expect(screen.getByLabelText('Handle')).toHaveValue('john-smith1987');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Continue as @john-smith1987' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/authorize'));
    expect(chosen).toEqual({ handle: 'john-smith1987' });
    expect(localStorage.getItem('pekohub_token')).toBe('t2');
  });

  it('checks a new handle and refuses one someone has', async () => {
    server.use(
      http.get('/v1/auth/me', () => HttpResponse.json(me())),
      http.get('/v1/auth/handle/:handle', ({ params }) =>
        HttpResponse.json(
          params.handle === 'john'
            ? { handle: 'john', available: false, reason: 'taken' }
            : { handle: params.handle, available: true },
        ),
      ),
    );
    renderAt('/welcome');
    const user = userEvent.setup();
    const input = await screen.findByLabelText('Handle');

    await user.clear(input);
    await user.type(input, '@John');
    expect(await screen.findByText('Someone already has that handle.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue as @john' })).toBeDisabled();

    await user.type(input, 'smith');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue as @johnsmith' })).toBeEnabled());
  });

  it('says what a handle may contain before asking the server', async () => {
    server.use(http.get('/v1/auth/me', () => HttpResponse.json(me())));
    renderAt('/welcome');
    const user = userEvent.setup();
    const input = await screen.findByLabelText('Handle');

    await user.clear(input);
    await user.type(input, 'john.');
    expect(await screen.findByText(/2 to 39 lowercase letters/)).toBeInTheDocument();
  });

  it('a fixed handle is shown, not edited', async () => {
    server.use(http.get('/v1/auth/me', () => HttpResponse.json(me({ handleLocked: true }))));
    renderAt('/welcome');

    expect(await screen.findByRole('heading', { name: 'Your handle' })).toBeInTheDocument();
    expect(screen.getByLabelText('Handle')).toHaveAttribute('readonly');
  });
});

describe('/auth/callback', () => {
  it('sends a first sign-in to choose a handle', async () => {
    server.use(http.get('/v1/auth/me', () => HttpResponse.json(me())));
    window.location.hash = '#token=fresh';
    const router = renderAt('/auth/callback');

    await waitFor(() => expect(router.state.location.pathname).toBe('/welcome'));
  });

  it('sends a returning person straight on', async () => {
    server.use(http.get('/v1/auth/me', () => HttpResponse.json(me({ handleChosen: true }))));
    window.location.hash = '#token=fresh';
    const router = renderAt('/auth/callback');

    await waitFor(() => expect(router.state.location.pathname).toBe('/dashboard'));
  });
});
