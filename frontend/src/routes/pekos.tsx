import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDownWideNarrow, Radar, Search, Sparkles, X } from 'lucide-react';
import { z } from 'zod';
import { api } from '~/lib/api';
import { PageHeader, PageShell } from '~/components/PageShell';
import { PekoCard } from '~/components/PekoCard';
import { EmptyState, ErrorNote, LoadingBlock } from '~/components/ui';

/**
 * Public peko directory.
 *
 * A peko is a live, runtime-owned actor (ADR-059), so this page lists
 * *instances* — status, owner, category — via the anonymous discovery
 * endpoints. Only `exposure = public` instances are indexed; `unlisted`
 * pekos are reachable by share link but never appear here (ADR-003).
 *
 * Search input is debounced locally so a fast typist doesn't fire one
 * request per keystroke; React Query keys on the settled value.
 */

const CATEGORIES = [
  'productivity',
  'coding',
  'creative',
  'business',
  'entertainment',
  'education',
  'other',
] as const;

const SORTS = [
  { value: 'recent', label: 'Most recent' },
  { value: 'trending', label: 'Trending' },
  { value: 'new', label: 'Recently published' },
  { value: 'featured', label: 'Featured' },
] as const;

type Sort = (typeof SORTS)[number]['value'];

const searchSchema = z.object({
  q: z.string().optional(),
  category: z.enum(CATEGORIES).optional(),
  sort: z.enum(['recent', 'trending', 'new', 'featured']).optional(),
});

export const Route = createFileRoute('/pekos')({
  validateSearch: searchSchema,
  component: PekosPage,
});

function PekosPage() {
  const { q = '', category, sort = 'recent' } = Route.useSearch();
  const navigate = useNavigate();

  // Local mirror of `q` so typing stays instant while the request
  // settles behind a debounce.
  const [input, setInput] = useState(q);
  useEffect(() => setInput(q), [q]);
  const debounced = useDebounced(input, 300);

  useEffect(() => {
    if (debounced === q) return;
    void navigate({
      to: '/pekos',
      search: { q: debounced || undefined, category, sort },
      replace: true,
    });
  }, [debounced, q, category, sort, navigate]);

  const results = useQuery({
    queryKey: ['pekos', { q, category, sort }],
    queryFn: () =>
      api.discoverySearch({
        q: q || undefined,
        category,
        sort: sort === 'recent' ? undefined : sort,
        page: 1,
        perPage: 24,
      }),
    placeholderData: (prev) => prev,
  });

  const hits = results.data?.hits ?? [];
  const hasFilters = Boolean(q || category || (sort && sort !== 'recent'));

  return (
    <PageShell width="wide">
      <PageHeader
        eyebrow="directory"
        title="Pekos"
        description="Live actors on runtimes across the network. Open one and you are talking to it — no install, no account."
      />

      {/* Filter bar */}
      <div className="mt-8 flex flex-col gap-4">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
            aria-hidden
          />
          <input
            type="search"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Search by name, description or tag…"
            aria-label="Search pekos"
            className="input py-2.5 pl-10 pr-10"
          />
          {input && (
            <button
              onClick={() => setInput('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-500 transition-colors hover:text-slate-300"
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            onClick={() => void navigate({ to: '/pekos', search: { q: q || undefined, sort } })}
            className={`chip ${!category ? 'chip-on' : ''}`}
          >
            <Radar className="h-3 w-3" />
            All
          </button>
          {CATEGORIES.map((value) => (
            <button
              key={value}
              onClick={() =>
                void navigate({
                  to: '/pekos',
                  search: {
                    q: q || undefined,
                    category: category === value ? undefined : value,
                    sort,
                  },
                })
              }
              className={`chip capitalize ${category === value ? 'chip-on' : ''}`}
            >
              {value}
            </button>
          ))}

          <div className="ml-auto flex items-center gap-2">
            <ArrowDownWideNarrow className="h-3.5 w-3.5 text-slate-600" aria-hidden />
            <select
              value={sort}
              onChange={(event) =>
                void navigate({
                  to: '/pekos',
                  search: { q: q || undefined, category, sort: event.target.value as Sort },
                })
              }
              aria-label="Sort pekos"
              className="select w-44 py-1.5 text-xs"
            >
              {SORTS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Results */}
      <section className="mt-8">
        {results.isLoading ? (
          <LoadingBlock label="Loading pekos" />
        ) : results.isError ? (
          <ErrorNote>
            Could not load the directory —{' '}
            {results.error instanceof Error ? results.error.message : 'unknown error'}
          </ErrorNote>
        ) : hits.length === 0 ? (
          <EmptyState
            icon={<Sparkles className="h-5 w-5" />}
            title={hasFilters ? 'No pekos matched' : 'Nobody is public yet'}
            body={
              hasFilters ? (
                <button
                  onClick={() => void navigate({ to: '/pekos', search: {} })}
                  className="link"
                >
                  Clear all filters
                </button>
              ) : (
                <>
                  Public pekos appear here once their owner sets{' '}
                  <code className="code-inline">exposure = &quot;public&quot;</code> in{' '}
                  <code className="code-inline">principal.toml</code>.
                </>
              )
            }
          />
        ) : (
          <>
            <p className="eyebrow mb-4">
              {results.data?.total ?? hits.length} public peko
              {(results.data?.total ?? hits.length) === 1 ? '' : 's'}
            </p>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {hits.map((hit) => (
                <PekoCard key={hit.id} hit={hit} />
              ))}
            </div>
          </>
        )}
      </section>
    </PageShell>
  );
}

/** Settle a fast-changing value after `delay` ms of quiet. */
function useDebounced<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return useMemo(() => settled, [settled]);
}
