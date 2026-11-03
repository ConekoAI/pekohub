/**
 * `/dashboard/runtimes` — the computers registered to your account.
 *
 * A runtime is one Peko installation. Registering it (signing in from Peko
 * desktop, or `peko runtime register`) is what lets its pekos go online.
 * Unregistering takes its pekos out of the directory and closes its tunnel.
 */

import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cpu, RefreshCw } from 'lucide-react';
import { api } from '~/lib/api';
import { AppShell } from '~/components/AppShell';
import { EmptyState, Loading, Spinner, StatusDot, Unavailable } from '~/components/ui';
import { PageHeader } from '~/components/PageShell';
import { relativeTime } from '~/lib/format';

export const Route = createFileRoute('/dashboard_/runtimes')({
  head: () => ({ meta: [{ title: 'Runtimes — PekoHub' }] }),
  component: RuntimesPage,
});

function RuntimesPage() {
  const queryClient = useQueryClient();
  const runtimes = useQuery({ queryKey: ['runtimes'], queryFn: () => api.listRuntimes() });
  const unregister = useMutation({
    mutationFn: (did: string) => api.unregisterRuntime(did),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['runtimes'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
  const rows = runtimes.data?.runtimes ?? [];

  return (
    <AppShell>
      <PageHeader
        title="Runtimes"
        action={
          <button
            onClick={() => void runtimes.refetch()}
            disabled={runtimes.isFetching}
            className="btn-icon"
            aria-label="Refresh"
            title="Refresh"
          >
            {runtimes.isFetching ? <Spinner className="h-4 w-4" /> : <RefreshCw className="h-4 w-4" />}
          </button>
        }
      />

      <div className="mt-8">
        {runtimes.isLoading ? (
          <Loading />
        ) : runtimes.isError ? (
          <Unavailable />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Cpu className="h-5 w-5" />}
            title="No computers yet"
            body="Sign in to PekoHub from Peko desktop."
          />
        ) : (
          <ul className="rows">
            {rows.map((runtime) => (
              <li key={runtime.id} className="flex flex-wrap items-center gap-4 px-5 py-4" data-testid="runtime-row">
                <StatusDot status={runtime.connected ? 'online' : 'offline'} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-100" title={runtime.runtimeDid}>
                    {runtime.displayName ?? 'Peko runtime'}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {runtime.connected
                      ? 'connected'
                      : runtime.lastSeenAt
                        ? `last seen ${relativeTime(runtime.lastSeenAt)}`
                        : 'never connected'}
                  </p>
                </div>
                <span className="text-xs text-slate-500">
                  {runtime.pekoCount ?? 0} peko{runtime.pekoCount === 1 ? '' : 's'} online
                </span>
                <button
                  type="button"
                  disabled={unregister.isPending}
                  onClick={() => {
                    const count = runtime.pekoCount ?? 0;
                    const warning = count > 0 ? ` Its ${count} peko${count === 1 ? '' : 's'} will go offline.` : '';
                    if (window.confirm(`Unregister this computer from PekoHub?${warning}`)) {
                      unregister.mutate(runtime.runtimeDid);
                    }
                  }}
                  className="btn-danger btn-sm"
                >
                  Unregister
                </button>
              </li>
            ))}
          </ul>
        )}
        {unregister.isError && <p className="mt-3 text-xs text-rose-300">{String(unregister.error)}</p>}
      </div>
    </AppShell>
  );
}
