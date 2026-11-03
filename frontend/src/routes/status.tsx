/**
 * `/status` — is PekoHub up, checked live from your browser.
 *
 * Each row times one public request: the API itself, the directory (search
 * and feeds), and the seed registry. The relay has no public probe; it runs
 * in the API process, so the API row speaks for it.
 */

import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { API_BASE } from '~/lib/api';
import { PageHeader, PageShell } from '~/components/PageShell';
import { Spinner, StatusDot } from '~/components/ui';

export const Route = createFileRoute('/status')({
  component: StatusPage,
  head: () => ({ meta: [{ title: 'PekoHub status' }] }),
});

interface Check {
  id: string;
  label: string;
  path: string;
}

const CHECKS: Check[] = [
  { id: 'api', label: 'API and relay', path: '/health' },
  { id: 'search', label: 'Search', path: '/v1/search?q=peko&perPage=1' },
  { id: 'seeds', label: 'Seeds', path: '/v1/seeds?perPage=1' },
];

interface Result {
  ok: boolean;
  ms: number;
}

/** One timed request; a non-2xx or non-JSON answer is down. */
export async function probe(path: string, fetcher: typeof fetch = fetch): Promise<Result> {
  const started = performance.now();
  try {
    const response = await fetcher(`${API_BASE}${path}`, { cache: 'no-store' });
    await response.json();
    return { ok: response.ok, ms: Math.round(performance.now() - started) };
  } catch {
    return { ok: false, ms: Math.round(performance.now() - started) };
  }
}

function StatusRow({ check }: { check: Check }) {
  const result = useQuery({
    queryKey: ['status', check.id],
    queryFn: () => probe(check.path),
    refetchInterval: 30_000,
    retry: false,
  });
  return (
    <li className="flex items-center gap-3.5 px-5 py-4" data-testid={`status-${check.id}`}>
      {result.isLoading ? (
        <Spinner className="h-3 w-3" />
      ) : (
        <span aria-label={result.data?.ok ? 'up' : 'down'}>
          <StatusDot status={result.data?.ok ? 'online' : 'error'} />
        </span>
      )}
      <p className="flex-1 text-sm text-slate-200">{check.label}</p>
      <span className="text-xs tabular-nums text-slate-500">
        {result.data ? (result.data.ok ? `${result.data.ms} ms` : 'Down') : ''}
      </span>
    </li>
  );
}

function StatusPage() {
  const overall = useQuery({
    queryKey: ['status', 'all'],
    queryFn: async () => (await Promise.all(CHECKS.map((c) => probe(c.path)))).every((r) => r.ok),
    refetchInterval: 30_000,
    retry: false,
  });

  return (
    <PageShell width="narrow">
      <PageHeader
        title={
          overall.isLoading
            ? 'Checking PekoHub…'
            : overall.data
              ? 'All systems normal'
              : 'Some of PekoHub isn’t answering'
        }
        action={
          <button
            type="button"
            onClick={() => void overall.refetch()}
            className="btn-icon"
            aria-label="Check now"
            title="Check now"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        }
      />
      <ul className="rows mt-8">
        {CHECKS.map((check) => (
          <StatusRow key={check.id} check={check} />
        ))}
      </ul>
    </PageShell>
  );
}
