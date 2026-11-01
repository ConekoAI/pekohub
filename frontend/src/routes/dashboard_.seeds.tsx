/**
 * `/dashboard/seeds` — the seeds you've published.
 */

import { Link, createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Boxes, Plus } from 'lucide-react';
import { api } from '~/lib/api';
import { useAuth } from '~/hooks/useAuth';
import { AppShell } from '~/components/AppShell';
import { EmptyState, ErrorNote, Spinner, Stat } from '~/components/ui';
import { compactNumber, relativeTime } from '~/lib/format';

export const Route = createFileRoute('/dashboard_/seeds')({
  head: () => ({ meta: [{ title: 'Your seeds — PekoHub' }] }),
  component: MySeedsPage,
});

function MySeedsPage() {
  const { user } = useAuth();
  const seeds = useQuery({
    queryKey: ['my-seeds', user?.namespace],
    queryFn: () => api.listSeedsBy(user!.namespace),
    enabled: !!user,
  });
  const items = seeds.data?.items ?? [];
  const downloads = items.reduce((sum, item) => sum + item.pullCount, 0);

  return (
    <AppShell>
      <div className="mb-8 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow mb-2.5">console</p>
          <h1 className="display text-2xl sm:text-[28px]">Your seeds</h1>
          <p className="lede mt-2 max-w-2xl">What others can grow their own pekos from.</p>
        </div>
        <Link to="/seeds/new" className="btn-primary btn-sm">
          <Plus className="h-3.5 w-3.5" />
          Publish a seed
        </Link>
      </div>

      {items.length > 0 && (
        <div className="mb-6 grid max-w-md grid-cols-2 gap-3">
          <Stat label="seeds" value={String(items.length)} />
          <Stat label="downloads" value={compactNumber(downloads)} />
        </div>
      )}

      {seeds.isLoading ? (
        <div className="flex items-center justify-center gap-2.5 py-12 text-sm text-slate-500">
          <Spinner className="h-4 w-4" />
          Loading seeds…
        </div>
      ) : seeds.isError ? (
        <ErrorNote>PekoHub isn&apos;t answering right now. Try again in a moment.</ErrorNote>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Boxes className="h-5 w-5" />}
          title="You haven't published a seed"
          body={
            <>
              Export one from a peko with <code className="code-inline">peko seed &lt;name&gt;</code>,
              then publish it.
            </>
          }
        />
      ) : (
        <ul className="divide-y divide-white/[0.06] overflow-hidden rounded-xl border border-white/[0.07] bg-ink-850/70">
          {items.map((seed) => (
            <li key={seed.name}>
              <Link
                to="/seeds/$"
                params={{ _splat: `${seed.owner}/${seed.name}` }}
                className="flex items-center gap-4 px-4 py-4 transition-colors hover:bg-white/[0.03]"
              >
                <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-iris-400/20 bg-iris-400/[0.07]">
                  {seed.avatar ?? <span className="font-mono text-xs text-iris-300">{seed.name.slice(0, 2)}</span>}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-slate-200">{seed.displayName ?? seed.name}</span>
                  <span className="block truncate font-mono text-2xs text-slate-600">
                    {seed.owner}/{seed.name} · updated {relativeTime(seed.updatedAt)}
                  </span>
                </span>
                <span className="font-mono text-2xs text-slate-500">{compactNumber(seed.pullCount)} downloads</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </AppShell>
  );
}
