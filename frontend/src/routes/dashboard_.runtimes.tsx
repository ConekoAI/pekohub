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
import { EmptyState, ErrorNote, Spinner, StatusDot } from '~/components/ui';
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
      <div className="mb-8 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow mb-2.5">console</p>
          <h1 className="display text-2xl sm:text-[28px]">Runtimes</h1>
          <p className="lede mt-2 max-w-2xl">
            The computers your pekos run on. A runtime registered here can put its pekos online.
          </p>
        </div>
        <button
          onClick={() => void runtimes.refetch()}
          disabled={runtimes.isFetching}
          className="btn-secondary btn-sm"
        >
          {runtimes.isFetching ? <Spinner className="h-3.5 w-3.5" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Refresh
        </button>
      </div>

      {runtimes.isLoading ? (
        <div className="flex items-center justify-center gap-2.5 py-12 text-sm text-slate-500">
          <Spinner className="h-4 w-4" />
          Loading runtimes…
        </div>
      ) : runtimes.isError ? (
        <ErrorNote>PekoHub isn&apos;t answering right now. Try again in a moment.</ErrorNote>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Cpu className="h-5 w-5" />}
          title="No computers registered yet"
          body={
            <>
              Sign in to PekoHub from Peko desktop, or run{' '}
              <code className="code-inline">peko runtime register</code> on the computer.
            </>
          }
        />
      ) : (
        <ul className="divide-y divide-white/[0.06] overflow-hidden rounded-xl border border-white/[0.07] bg-ink-850/70">
          {rows.map((runtime) => (
            <li key={runtime.id} className="flex flex-wrap items-center gap-4 px-4 py-4" data-testid="runtime-row">
              <StatusDot status={runtime.connected ? 'online' : 'offline'} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-200">
                  {runtime.displayName ?? 'Peko runtime'}
                  <span className="ml-2 text-2xs font-normal text-slate-500">
                    {runtime.connected ? 'connected' : runtime.lastSeenAt ? `last seen ${relativeTime(runtime.lastSeenAt)}` : 'never connected'}
                  </span>
                </p>
                <p className="truncate font-mono text-2xs text-slate-600" title={runtime.runtimeDid}>
                  {runtime.runtimeDid}
                </p>
              </div>
              <span className="font-mono text-2xs text-slate-500">
                {runtime.pekoCount ?? 0} peko{runtime.pekoCount === 1 ? '' : 's'} online
              </span>
              <button
                type="button"
                disabled={unregister.isPending}
                onClick={() => {
                  const count = runtime.pekoCount ?? 0;
                  const warning = count > 0 ? ` Its ${count} peko${count === 1 ? '' : 's'} will leave the directory.` : '';
                  if (window.confirm(`Unregister this computer from PekoHub?${warning}`)) {
                    unregister.mutate(runtime.runtimeDid);
                  }
                }}
                className="btn-ghost btn-sm text-rose-300 hover:text-rose-200"
              >
                Unregister
              </button>
            </li>
          ))}
        </ul>
      )}
      {unregister.isError && <p className="mt-3 text-2xs text-rose-300">{String(unregister.error)}</p>}
    </AppShell>
  );
}
