import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { routeTree } from '~/routeTree.gen';
import { http, HttpResponse } from 'msw';
import { server } from '~/test/mocks/server';
import { createTestQueryClient } from '~/test/utils';

function renderDashboard() {
  const queryClient = createTestQueryClient();
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ['/dashboard'] }),
    context: { queryClient },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

async function openOwnerTab() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Manage' }));
  await user.click(screen.getByRole('button', { name: 'Owner' }));
  return user;
}

describe('transferring a peko from the console', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('offers it to another account by handle, after confirming', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderDashboard();
    const user = await openOwnerTab();
    await user.type(screen.getByPlaceholderText('@handle'), '@bob');
    await user.click(screen.getByRole('button', { name: /^Offer / }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('@bob'));
    // The dialog closes once the offer is made.
    await waitFor(() => expect(screen.queryByPlaceholderText('@handle')).not.toBeInTheDocument());
  });

  it("shows the hub's reason when the handle is unknown", async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderDashboard();
    const user = await openOwnerTab();
    await user.type(screen.getByPlaceholderText('@handle'), 'nobody');
    await user.click(screen.getByRole('button', { name: /^Offer / }));
    expect(await screen.findByText(/No PekoHub user is called @nobody/)).toBeInTheDocument();
  });

  it('shows a peko offered to you and accepts it', async () => {
    let accepted: string | null = null;
    server.use(
      http.get('/v1/me/transfers', () =>
        HttpResponse.json({
          transfers: accepted
            ? []
            : [
                {
                  hubId: 'hub-ada',
                  direction: 'incoming',
                  pekoName: 'ada',
                  pekoAvatar: null,
                  otherHandle: 'alice',
                  createdAt: new Date().toISOString(),
                  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
                },
              ],
        }),
      ),
      http.post('/v1/principals/by-hub-id/:hubId/transfer/accept', ({ params }) => {
        accepted = String(params.hubId);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderDashboard();
    expect(await screen.findByText(/@alice offers you ada/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(accepted).toBe('hub-ada'));
    await waitFor(() => expect(screen.queryByText(/@alice offers you ada/)).not.toBeInTheDocument());
  });
});
