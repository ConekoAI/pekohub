import { createFileRoute, useNavigate, useSearch as useRouteSearch } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Boxes, Database, Loader2, Terminal, TriangleAlert } from 'lucide-react';
import { z } from 'zod';
import { api } from '~/lib/api';
import { classifyRepo, type RepoRef } from '~/lib/repo';
import { PageHeader, PageShell } from '~/components/PageShell';
import { SearchBar } from '~/components/SearchBar';
import { SeedCard, SeedRepoRow } from '~/components/SeedCard';
import { Badge, CopyButton, EmptyState, ErrorNote } from '~/components/ui';
import { useSeedCatalog } from '~/hooks/useSeed';

/**
 * Seed directory.
 *
 * The hub is a seed-only registry (pekohub ADR-005 §2, runtime
 * ADR-056 D6): a push carries a stripped `principal.toml` — DNA — and
 * never an existence, a key, or a capability package.
 *
 * Two sources, deliberately:
 *  - the OCI catalog (`/v2/_catalog`) is the registry's real contents
 *    and drives the default listing;
 *  - full-text search (`/v1/search`) is used once a query is typed,
 *    filtered server-side to `bundleType = principal` so retired
 *    extension rows can never surface.
 *
 * Retired lanes (`peko/extensions/…`, `peko/agents/…`) are dropped
 * from the listing — runtime ADR-037 superseded the `.agent` bundle
 * and ADR-047 §5 / ADR-050 moved capabilities into plain workspace
 * files, so those paths are residue.
 */

const searchSchema = z.object({ q: z.string().optional() });

export const Route = createFileRoute('/seeds/')({
  validateSearch: searchSchema,
  component: SeedsPage,
});

function SeedsPage() {
  const { q = '' } = useRouteSearch({ from: '/seeds/' });
  const navigate = useNavigate();

  const handleSearch = (query: string) => {
    void navigate({ to: '/seeds', search: query ? { q: query } : {}, replace: true });
  };

  return (
    <PageShell width="wide">
      <PageHeader
        eyebrow="registry · OCI distribution v1.1"
        title="Seeds"
        description={
          <>
            Seeds are the DNA a peko grows from — a stripped{' '}
            <code className="code-inline">principal.toml</code> pushed as a zero-layer manifest.
            Pull one and ground it with <code className="code-inline">peko create -s</code>.
          </>
        }
        action={<Badge tone="iris">DNA only</Badge>}
      />

      <div className="mt-8 max-w-2xl">
        <SearchBar
          initialQuery={q}
          onSearch={handleSearch}
          placeholder="Search seeds by name, tag or author…"
          size="md"
        />
      </div>

      <div className="mt-8">{q ? <SearchResults q={q} /> : <CatalogListing />}</div>
    </PageShell>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   Search results (query present)
   ───────────────────────────────────────────────────────────────────────── */

function SearchResults({ q }: { q: string }) {
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: ['seed-search', q],
    queryFn: () =>
      api.search({
        q,
        page: 1,
        perPage: 24,
        // Server-side: keep the directory seed-only. `bundleType`
        // is a filterable attribute on the bundles index.
        filters: { bundleType: 'principal' },
      }),
    placeholderData: (prev) => prev,
  });

  if (query.isLoading) {
    return (
      <div className="flex items-center justify-center gap-2.5 py-24 text-sm text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin text-peko-400" />
        Searching…
      </div>
    );
  }

  if (query.isError) {
    return (
      <ErrorNote>
        Search failed — {query.error instanceof Error ? query.error.message : 'unknown error'}
      </ErrorNote>
    );
  }

  const items = query.data?.items ?? [];

  return (
    <section>
      <div className="flex items-baseline justify-between gap-4">
        <p className="eyebrow">
          {items.length} result{items.length === 1 ? '' : 's'} · “{q}”
        </p>
        <button
          onClick={() => void navigate({ to: '/seeds', search: {} })}
          className="btn-ghost btn-sm"
        >
          Clear
        </button>
      </div>

      {items.length === 0 ? (
        <div className="mt-4">
          <EmptyState
            icon={<Boxes className="h-5 w-5" />}
            title="No seeds matched"
            body="Seed names and descriptions are indexed. Try a shorter query, or browse the catalog instead."
          />
        </div>
      ) : (
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item) => (
            <SeedCard key={`${item.namespace}/${item.name}`} item={item} />
          ))}
        </div>
      )}
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   Catalog listing (no query)
   ───────────────────────────────────────────────────────────────────────── */

function CatalogListing() {
  const catalog = useSeedCatalog();
  const [filter, setFilter] = useState('');

  const { seeds, retired } = useMemo(() => {
    const repositories = catalog.data?.repositories ?? [];
    const parsed = repositories
      .map(classifyRepo)
      .filter((entry): entry is RepoRef => entry !== null);

    return {
      seeds: parsed.filter((entry) => entry.isSeed),
      retired: parsed.filter((entry) => entry.isRetired),
    };
  }, [catalog.data]);

  const visible = filter
    ? seeds.filter((entry) => entry.repo.toLowerCase().includes(filter.toLowerCase()))
    : seeds;

  if (catalog.isLoading) {
    return (
      <div className="flex items-center justify-center gap-2.5 py-24 text-sm text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin text-peko-400" />
        Reading registry catalog…
      </div>
    );
  }

  if (catalog.isError) {
    return (
      <ErrorNote>
        Could not read the registry catalog —{' '}
        {catalog.error instanceof Error ? catalog.error.message : 'unknown error'}
      </ErrorNote>
    );
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <section>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="eyebrow">
            {visible.length} seed{visible.length === 1 ? '' : 's'} in the catalog
          </p>
          {seeds.length > 8 && (
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter paths…"
              className="input w-52 py-1.5 text-xs"
              aria-label="Filter repository paths"
            />
          )}
        </div>

        {visible.length === 0 ? (
          <div className="mt-4">
            <EmptyState
              icon={<Boxes className="h-5 w-5" />}
              title={filter ? 'No paths matched the filter' : 'The registry is empty'}
              body={
                filter ? (
                  'Try a shorter filter.'
                ) : (
                  <>
                    Nothing has been pushed yet. Publish the first one with{' '}
                    <code className="code-inline">peko push</code>.
                  </>
                )
              }
            />
          </div>
        ) : (
          <div className="mt-4 flex flex-col gap-2">
            {visible.map((entry) => (
              <SeedRepoRow key={entry.repo} entry={entry} />
            ))}
          </div>
        )}

        {retired.length > 0 && (
          <div className="mt-6 flex items-start gap-3 rounded-lg border border-amber-400/20 bg-amber-400/[0.05] px-4 py-3">
            <TriangleAlert className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-400" />
            <div className="text-[13px] leading-relaxed text-amber-200/90">
              <p className="font-medium text-amber-200">
                {retired.length} path{retired.length === 1 ? '' : 's'} under a retired lane
              </p>
              <p className="mt-1 text-amber-200/70">
                <span className="font-mono">peko/extensions/…</span> and{' '}
                <span className="font-mono">peko/agents/…</span> are hidden here. The standalone
                extension and agent package formats were superseded (ADR-037, ADR-047 §5, ADR-050) —
                capabilities are plain workspace files now.
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {retired.slice(0, 6).map((entry) => (
                  <span
                    key={entry.repo}
                    className="rounded border border-amber-400/20 bg-amber-400/[0.06] px-1.5 py-0.5 font-mono text-2xs text-amber-200/70"
                  >
                    {entry.repo}
                  </span>
                ))}
                {retired.length > 6 && (
                  <span className="px-1.5 py-0.5 font-mono text-2xs text-amber-200/50">
                    +{retired.length - 6} more
                  </span>
                )}
              </div>
            </div>
          </div>
        )}
      </section>

      <PublishGuide />
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   Side guide
   ───────────────────────────────────────────────────────────────────────── */

function PublishGuide() {
  return (
    <aside className="space-y-4">
      <div className="panel p-5">
        <div className="flex items-center gap-2">
          <Terminal className="h-4 w-4 text-peko-300" />
          <p className="eyebrow text-slate-400">publish</p>
        </div>
        <p className="mt-3 text-[13px] leading-relaxed text-slate-400">
          Seeds go up from a runtime, never from the browser. The hub only ever sees the config
          blob — keys, sessions and knowledge stay on your machine.
        </p>
        <div className="mt-4 space-y-2">
          <code className="code-block text-xs">peko push my-peko</code>
          <code className="code-block text-xs">peko pull pekohub.ai/peko/principals/my-peko:latest</code>
        </div>
        <div className="mt-3">
          <CopyButton
            value="peko pull pekohub.ai/peko/principals/my-peko:latest"
            label="Copy pull command"
            className="btn-secondary btn-sm w-full"
          />
        </div>
      </div>

      <div className="card p-5">
        <div className="flex items-center gap-2">
          <Database className="h-4 w-4 text-iris-300" />
          <p className="eyebrow text-slate-400">layout</p>
        </div>
        <ul className="mt-3 space-y-2.5 text-[13px] text-slate-400">
          <li className="flex items-start gap-2">
            <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-iris-400" />
            <span>
              <code className="code-inline">peko/principals/&lt;name&gt;</code> — the seed lane
            </span>
          </li>
          <li className="flex items-start gap-2">
            <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-slate-600" />
            <span>
              <code className="code-inline">&lt;namespace&gt;/&lt;name&gt;</code> — pre-ADR-005 rows
            </span>
          </li>
          <li className="flex items-start gap-2">
            <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-amber-400" />
            <span>
              <code className="code-inline">peko/extensions/…</code> — retired lane
            </span>
          </li>
        </ul>
      </div>
    </aside>
  );
}
