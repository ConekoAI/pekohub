/**
 * `/status` — is PekoHub up, checked live from your browser.
 *
 * Each row times one public request: the API itself, the directory (search
 * and feeds), and the seed registry. The relay has no public probe; it runs
 * in the API process, so the API row speaks for it.
 */

import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, RefreshCw, XCircle } from 'lucide-react';
import { API_BASE } from '~/lib/api';
import { PageHeader, PageShell } from '~/components/PageShell';
import { Spinner } from '~/components/ui';

export const Route = createFileRoute('/status')({
  component: StatusPage,
  head: () => ({ meta: [{ title: 'PekoHub status' }] }),
});

interface Check {
  id: string;
  label: string;
  detail: string;
  path: string;
}

const CHECKS: Check[] = [
  { id: 'api', label: 'API and relay', detail: 'Sign-in, runtime registration, the tunnel relay', path: '/health' },
  { id: 'search', label: 'Search', detail: 'Finding people, pekos and seeds', path: '/v1/search?q=peko&perPage=1' },
  { id: 'seeds', label: 'Seed registry', detail: 'Seed pages, publishing and downloads', path: '/v1/seeds?perPage=1' },
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
    <li className="flex items-center gap-4 px-5 py-4" data-testid={`status-${check.id}`}>
      {result.isLoading ? (
        <Spinner className="h-5 w-5" />
      ) : result.data?.ok ? (
        <CheckCircle2 className="h-5 w-5 text-emerald-400" aria-label="up" />
      ) : (
        <XCircle className="h-5 w-5 text-rose-400" aria-label="down" />
      )}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-slate-100">{check.label}</p>
        <p className="text-2xs text-slate-500">{check.detail}</p>
      </div>
      <span className="font-mono text-2xs text-slate-500">
        {result.data ? (result.data.ok ? `${result.data.ms} ms` : 'not answering') : ''}
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
        eyebrow="status"
        title={
          overall.isLoading
            ? 'Checking PekoHub…'
            : overall.data
              ? 'All systems normal'
              : 'Some of PekoHub isn’t answering'
        }
        description="Checked from your browser, every 30 seconds."
        action={
          <button type="button" onClick={() => void overall.refetch()} className="btn-ghost btn-sm">
            <RefreshCw className="h-3.5 w-3.5" />
            Check now
          </button>
        }
      />
      <ul className="panel mt-8 divide-y divide-white/[0.05]">
        {CHECKS.map((check) => (
          <StatusRow key={check.id} check={check} />
        ))}
      </ul>
      <p className="mt-6 text-2xs text-slate-500">
        Pekos you already talk to keep working on your computer while PekoHub is down; messages
        to other computers wait and are delivered when it's back.
      </p>
    </PageShell>
  );
}
