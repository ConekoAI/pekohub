import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { routeTree } from '~/routeTree.gen';

describe('signing in', () => {
  it('shows the account in the header as soon as the callback stores the token', async () => {
    // A fresh page load from the API's redirect: no saved token yet.
    localStorage.removeItem('pekohub_token');
    window.history.replaceState(null, '', '/auth/callback#token=fresh-token');
    // The app's own query defaults (main.tsx): data stays fresh 5 minutes.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: 5 * 60 * 1000, retry: false } },
    });
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ['/auth/callback'] }),
      context: { queryClient },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(router.state.location.pathname).toBe('/dashboard'));
    expect(localStorage.getItem('pekohub_token')).toBe('fresh-token');
    expect(await screen.findByRole('button', { name: 'Account' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument();
  });
});
