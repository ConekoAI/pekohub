import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { routeTree } from '~/routeTree.gen';
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

  it('hands it to another account by handle, after confirming', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderDashboard();
    const user = await openOwnerTab();
    await user.type(screen.getByPlaceholderText('@handle'), '@bob');
    await user.click(screen.getByRole('button', { name: /^Transfer / }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('@bob'));
    // The dialog closes once the hub accepts.
    await waitFor(() => expect(screen.queryByPlaceholderText('@handle')).not.toBeInTheDocument());
  });

  it("shows the hub's reason when the handle is unknown", async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderDashboard();
    const user = await openOwnerTab();
    await user.type(screen.getByPlaceholderText('@handle'), 'nobody');
    await user.click(screen.getByRole('button', { name: /^Transfer / }));
    expect(await screen.findByText(/No PekoHub user is called @nobody/)).toBeInTheDocument();
  });
});
