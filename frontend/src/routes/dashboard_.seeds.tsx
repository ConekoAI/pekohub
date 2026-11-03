/**
 * `/dashboard/seeds` — the seeds you've published.
 */

import { Link, createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Boxes, Download, Plus } from 'lucide-react';
import { api } from '~/lib/api';
import { useAuth } from '~/hooks/useAuth';
import { AppShell } from '~/components/AppShell';
import { EmptyState, Loading, Tile, Unavailable } from '~/components/ui';
import { PageHeader } from '~/components/PageShell';
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

  return (
    <AppShell>
      <PageHeader
        title="Your seeds"
        action={
          <Link to="/seeds/new" className="btn-primary btn-sm">
            <Plus className="h-3.5 w-3.5" />
            Publish a seed
          </Link>
        }
      />

      <div className="mt-8">
        {seeds.isLoading ? (
          <Loading />
        ) : seeds.isError ? (
          <Unavailable />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<Boxes className="h-5 w-5" />}
            title="No seeds yet"
            body={
              <>
                Export one with <code className="code-inline">peko seed &lt;name&gt;</code>
              </>
            }
          />
        ) : (
          <ul className="rows">
            {items.map((seed) => (
              <li key={seed.name}>
                <Link
                  to="/$owner/$name"
                  params={{ owner: seed.owner, name: seed.name }}
                  className="flex items-center gap-4 px-5 py-4 transition-colors hover:bg-ink-850"
                >
                  <Tile avatar={seed.avatar} name={seed.name} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-slate-100">{seed.displayName ?? seed.name}</span>
                    <span className="mt-0.5 block truncate text-xs text-slate-500">
                      {seed.owner}/{seed.name} · {relativeTime(seed.updatedAt)}
                    </span>
                  </span>
                  <span className="flex items-center gap-1.5 text-xs text-slate-500">
                    <Download className="h-3 w-3" />
                    {compactNumber(seed.pullCount)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </AppShell>
  );
}
