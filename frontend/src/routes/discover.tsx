import { createFileRoute } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search as SearchIcon, Loader2, AlertTriangle, Sparkles, Clock, Star } from 'lucide-react';
import { api } from '~/lib/api';
import { AppShell } from '~/components/AppShell';
import { PekoCard } from '~/components/PekoCard';

/**
 * PR #8: Discovery SPA page. Searches /v1/discovery/search and
 * renders the canonical category chips + sort dropdown + card
 * grid. The search input is debounced naturally — every keystroke
 * triggers a request, but Meilisearch is cheap and React Query
 * dedupes the inflight calls per queryKey.
 *
 * `sort` enum mirrors the backend: `default` / `trending` /
 * `new` / `featured`. The `default` arm sends no `sort` param so
 * the backend's own ordering wins.
 */
export const Route = createFileRoute('/discover')({
  component: DiscoverPage,
});

const CATEGORIES: Array<{ value: string; label: string } | null> = [
  null,
  { value: 'productivity', label: 'Productivity' },
  { value: 'coding', label: 'Coding' },
  { value: 'creative', label: 'Creative' },
  { value: 'business', label: 'Business' },
  { value: 'entertainment', label: 'Entertainment' },
  { value: 'education', label: 'Education' },
  { value: 'other', label: 'Other' },
];

const SORTS: Array<{ value: 'default' | 'trending' | 'new' | 'featured'; label: string; icon: typeof Sparkles }> = [
  { value: 'default', label: 'Recent', icon: Sparkles },
  { value: 'trending', label: 'Trending', icon: Sparkles },
  { value: 'new', label: 'New', icon: Clock },
  { value: 'featured', label: 'Featured', icon: Star },
];

function DiscoverPage() {
  const [q, setQ] = useState('');
  const [category, setCategory] = useState<string | undefined>(undefined);
  const [sort, setSort] = useState<'default' | 'trending' | 'new' | 'featured'>('default');

  // Stable queryKey so a category change invalidates cleanly.
  const queryKey = useMemo(
    () => ['discovery', 'search', { q, category, sort }] as const,
    [q, category, sort],
  );

  const search = useQuery({
    queryKey,
    queryFn: () =>
      api.discoverySearch({
        q: q.trim() || undefined,
        category,
        sort: sort === 'default' ? undefined : sort,
        page: 1,
        perPage: 24,
      }),
    placeholderData: (prev) => prev,
  });

  return (
    <AppShell>
      <header>
        <h1 className="text-2xl font-bold text-gray-900">Discover</h1>
        <p className="mt-1 text-sm text-gray-600">
          Browse public pekos shared across the PekoHub network.
        </p>
      </header>

      <div className="mt-6 space-y-4">
        {/* Search */}
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search pekos..."
            className="input pl-10"
          />
        </div>

        {/* Category chips */}
        <div className="flex flex-wrap items-center gap-1.5">
          {CATEGORIES.map((cat) => {
            const selected = (cat?.value ?? undefined) === category;
            return (
              <button
                key={cat?.value ?? '__all__'}
                onClick={() => setCategory(cat?.value)}
                className={
                  selected
                    ? 'rounded-full border border-peko-600 bg-peko-50 px-3 py-1 text-xs font-medium text-peko-700'
                    : 'rounded-full border border-gray-200 bg-white px-3 py-1 text-xs text-gray-600 hover:border-gray-300'
                }
              >
                {cat?.label ?? 'All categories'}
              </button>
            );
          })}
        </div>

        {/* Sort dropdown + result count */}
        <div className="flex items-center justify-between">
          <div className="text-xs text-gray-500">
            {search.data
              ? `${search.data.total} peko${search.data.total === 1 ? '' : 's'}`
              : ' '}
          </div>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as typeof sort)}
            className="input text-xs py-1.5"
          >
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <section className="mt-6">
        {search.isLoading ? (
          <div className="flex min-h-[30vh] items-center justify-center text-gray-500">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        ) : search.error ? (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              Failed to load results:{' '}
              {search.error instanceof Error ? search.error.message : 'Unknown error'}
            </div>
          </div>
        ) : !search.data || search.data.hits.length === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-300 bg-white p-12 text-center text-sm text-gray-500">
            No pekos matched. Try a different query or category.
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {search.data.hits.map((hit) => (
              <PekoCard key={hit.id} hit={hit} />
            ))}
          </div>
        )}
      </section>
    </AppShell>
  );
}