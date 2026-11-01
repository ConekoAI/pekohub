import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { routeTree } from '~/routeTree.gen';
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

describe('/seeds/new', () => {
  it('publishes and opens the seed page', async () => {
    const router = renderAt('/seeds/new');
    const user = userEvent.setup();
    const box = await screen.findByLabelText('Seed');
    await user.click(box);
    await user.paste('name = "ada"\n');
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    await screen.findByRole('heading', { name: 'Ada' });
    expect(router.state.location.pathname).toBe('/seeds/testuser/ada');
  });

  it("shows the Hub's reason when a seed is refused", async () => {
    renderAt('/seeds/new');
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText('Seed'));
    await user.paste('did = "x"\nname = "ada"\n');
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("A seed can't carry `did`");
  });

  it('holds the button until the version looks like 1.0.0', async () => {
    renderAt('/seeds/new');
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText('Seed'));
    await user.paste('name = "ada"\n');
    const version = screen.getByLabelText('Version');
    await user.clear(version);
    await user.type(version, 'latest');
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
  });
});
