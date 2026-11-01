import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { routeTree } from '~/routeTree.gen';
import { createTestQueryClient } from '~/test/utils';
import { formatUserCodeInput } from './device';

function renderAt(path: string) {
  const queryClient = createTestQueryClient();
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
    context: { queryClient },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('/authorize (desktop sign-in consent)', () => {
  it('asks the signed-in user to allow Peko desktop', async () => {
    renderAt('/authorize?request=signed-request');
    expect(
      await screen.findByRole('heading', { name: 'Peko desktop wants to use your PekoHub account' }),
    ).toBeInTheDocument();
    expect(screen.getByText('@testuser')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allow' })).toBeEnabled();
  });

  it('explains an expired request instead of showing a raw error', async () => {
    renderAt('/authorize?request=expired');
    expect(await screen.findByRole('heading', { name: 'This sign-in request expired' })).toBeInTheDocument();
  });

  it('explains an invalid link (bad client or redirect)', async () => {
    renderAt('/authorize?error=invalid_redirect_uri');
    expect(await screen.findByRole('heading', { name: "This sign-in link isn't valid" })).toBeInTheDocument();
  });
});

describe('/device (CLI sign-in)', () => {
  it('formats the code while typing', () => {
    expect(formatUserCodeInput('bcdfghjk')).toBe('BCDF-GHJK');
    expect(formatUserCodeInput('bcd')).toBe('BCD');
    expect(formatUserCodeInput('bc df-gh jk zz')).toBe('BCDF-GHJK');
  });

  it('looks up the prefilled code and approves it', async () => {
    renderAt('/device?code=bcdfghjk');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(
      await screen.findByRole('heading', { name: 'Peko CLI wants to use your PekoHub account' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Allow' }));
    expect(await screen.findByRole('heading', { name: 'Peko CLI is signed in' })).toBeInTheDocument();
  });

  it('says so when a code is not valid', async () => {
    renderAt('/device?code=zzzzzzzz');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(await screen.findByText(/not valid or has expired/)).toBeInTheDocument();
  });
});
