import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { routeTree } from '~/routeTree.gen';
import { createTestQueryClient } from '~/test/utils';
import { server } from '~/test/mocks/server';
import type { ModerationReport } from '~/lib/api';

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

function signedInAs(role: 'user' | 'moderator' | 'admin') {
  server.use(
    http.get('/v1/auth/me', () =>
      HttpResponse.json({
        id: 'user-mod',
        namespace: 'mod',
        displayName: 'Mod',
        role,
        createdAt: new Date('2026-01-01').toISOString(),
      }),
    ),
  );
}

function openReport(overrides: Partial<ModerationReport> = {}): ModerationReport {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    targetKind: 'seed',
    target: 'alice/ada@1.0.0',
    targetId: null,
    reason: 'malicious',
    note: 'Tells people to curl | sh',
    status: 'open',
    createdAt: new Date('2026-11-01').toISOString(),
    reporter: { handle: 'bob' },
    account: { id: 'user-alice', handle: 'alice', suspended: false },
    targetRemoved: false,
    resolvedBy: null,
    resolvedAt: null,
    resolution: null,
    ...overrides,
  };
}

describe('report buttons', () => {
  it('send a reason and a note about a seed version', async () => {
    let sent: unknown;
    server.use(
      http.post('/v1/reports', async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json({ id: 'r1', status: 'open', duplicate: false }, { status: 201 });
      }),
    );
    renderAt('/alice/ada');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Report' }));
    const dialog = screen.getByRole('dialog', { name: 'Report alice/ada@1.1.0' });
    const send = within(dialog).getByRole('button', { name: 'Send report' });
    expect(send).toBeDisabled();
    await user.click(within(dialog).getByLabelText('Malware or a scam'));
    await user.type(within(dialog).getByLabelText(/Details/), 'Runs a miner');
    await user.click(send);
    expect(await within(dialog).findByText(/A PekoHub moderator will take a look/)).toBeInTheDocument();
    expect(sent).toEqual({ target: 'alice/ada@1.1.0', reason: 'malicious', note: 'Runs a miner' });
  });

  it('ask a signed-out visitor to sign in first', async () => {
    localStorage.removeItem('pekohub_token');
    renderAt('/alice/ada');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Report' }));
    expect(screen.getByRole('dialog', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('show the Hub’s reason when a report is refused', async () => {
    server.use(
      http.post('/v1/reports', () =>
        HttpResponse.json({ error: 'You can send 10 reports an hour. Try again later.' }, { status: 429 }),
      ),
    );
    renderAt('/alice/ada');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Report' }));
    await user.click(screen.getByLabelText('Spam'));
    await user.click(screen.getByRole('button', { name: 'Send report' }));
    expect(await screen.findByText(/10 reports an hour/)).toBeInTheDocument();
  });
});

describe('/admin', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is not there for people who aren’t moderators', async () => {
    signedInAs('user');
    renderAt('/admin');
    expect(await screen.findByText('Nothing lives at this address')).toBeInTheDocument();
  });

  it('lists open reports with the actions that fit them', async () => {
    signedInAs('moderator');
    server.use(
      http.get('/v1/admin/reports', () =>
        HttpResponse.json({
          reports: [
            openReport(),
            openReport({
              id: '22222222-2222-4222-8222-222222222222',
              targetKind: 'peko',
              target: '@alice/ada',
              targetId: '33333333-3333-4333-8333-333333333333',
              note: null,
            }),
          ],
          total: 2,
        }),
      ),
    );
    renderAt('/admin');
    const [seedCard, pekoCard] = await screen.findAllByTestId('report');
    expect(within(seedCard).getByText('Tells people to curl | sh')).toBeInTheDocument();
    expect(within(seedCard).getByRole('button', { name: 'Hide seed' })).toBeInTheDocument();
    expect(within(seedCard).getByRole('button', { name: 'Yank v1.0.0' })).toBeInTheDocument();
    expect(within(seedCard).getByRole('button', { name: 'Suspend @alice' })).toBeInTheDocument();
    expect(within(seedCard).queryByRole('button', { name: 'Take off PekoHub' })).not.toBeInTheDocument();
    expect(within(pekoCard).getByRole('button', { name: 'Take off PekoHub' })).toBeInTheDocument();
    expect(within(pekoCard).queryByRole('button', { name: 'Hide seed' })).not.toBeInTheDocument();
  });

  it('hides a reported seed with the reason, closing the report', async () => {
    signedInAs('moderator');
    let reports = [openReport()];
    let hideBody: unknown;
    server.use(
      http.get('/v1/admin/reports', ({ request }) => {
        const status = new URL(request.url).searchParams.get('status');
        return HttpResponse.json({ reports: reports.filter((r) => r.status === status), total: reports.length });
      }),
      http.post('/v1/admin/seeds/:owner/:name/hide', async ({ request, params }) => {
        hideBody = { ...((await request.json()) as object), owner: params.owner, name: params.name };
        reports = [{ ...reports[0], status: 'actioned', targetRemoved: true }];
        return HttpResponse.json({ hidden: true });
      }),
    );
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderAt('/admin');
    const user = userEvent.setup();
    const card = await screen.findByTestId('report');
    await user.type(within(card).getByLabelText('Reason'), 'cryptominer');
    await user.click(within(card).getByRole('button', { name: 'Hide seed' }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('alice/ada'));
    await waitFor(() => expect(screen.getByText('Nothing to review')).toBeInTheDocument());
    expect(hideBody).toEqual({
      owner: 'alice',
      name: 'ada',
      hidden: true,
      reason: 'cryptominer',
      reportId: '11111111-1111-4111-8111-111111111111',
    });
  });
});
