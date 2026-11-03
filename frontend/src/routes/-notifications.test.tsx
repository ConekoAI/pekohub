import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { routeTree } from '~/routeTree.gen';
import { server } from '~/test/mocks/server';
import { createTestQueryClient } from '~/test/utils';

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

const OFFER = {
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'transfer.offered',
  text: '@alice offers you ada. Accept it to become its owner.',
  path: '/dashboard',
  url: 'https://pekohub.ai/dashboard',
  createdAt: new Date().toISOString(),
  readAt: null,
};

describe('the notification bell', () => {
  it('shows the unread count, marks what it shows as read, and opens the page it points at', async () => {
    let marked: string[] | undefined;
    server.use(
      http.get('/v1/me/notifications', () =>
        HttpResponse.json({ unread: marked ? 0 : 1, notifications: [{ ...OFFER, readAt: marked ? 'now' : null }] }),
      ),
      http.post('/v1/me/notifications/read', async ({ request }) => {
        marked = ((await request.json()) as { ids: string[] }).ids;
        return HttpResponse.json({ marked: marked.length });
      }),
    );
    const router = renderAt('/profile');
    const user = userEvent.setup();

    const bell = await screen.findByRole('button', { name: 'Notifications, 1 unread' });
    await user.click(bell);
    expect(await screen.findByText(/@alice offers you ada/)).toBeInTheDocument();
    await waitFor(() => expect(marked).toEqual([OFFER.id]));
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument();

    await user.click(screen.getByRole('menuitem', { name: /@alice offers you ada/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/dashboard'));
  });

  it('says so when there is nothing', async () => {
    renderAt('/profile');
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Notifications' }));
    expect(screen.getByText('Nothing yet.')).toBeInTheDocument();
  });
});
