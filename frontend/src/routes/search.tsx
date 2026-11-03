/**
 * `/search?q=` — seed search results, from the search box in the header.
 *
 * The website searches seeds only (hub ADR-009 amendment): finding a
 * person or a peko by ID is the desktop's job, and the desktop asks the
 * API (`GET /v1/search`) directly. A leading `@` is dropped, so `@alice`
 * finds alice's seeds, and an exact seed ID (`alice/ada`) comes first.
 * There is no seed directory: `/seeds` lands here.
 */

import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Search as SearchIcon } from 'lucide-react';
import { api } from '~/lib/api';
import { PageHeader, PageShell } from '~/components/PageShell';
import { SeedCard, type SeedCardItem } from '~/components/SeedCard';
import { EmptyState, Loading, Unavailable } from '~/components/ui';

export const Route = createFileRoute('/search')({
  head: () => ({ meta: [{ title: 'Search seeds — PekoHub' }] }),
  validateSearch: (search: Record<string, unknown>) => ({
    q: typeof search.q === 'string' && search.q.trim() ? search.q.trim() : undefined,
  }),
  component: SearchPage,
});

function SearchPage() {
  const { q } = Route.useSearch();

  return (
    <PageShell width="wide">
      {q ? (
        <Results q={q} />
      ) : (
        <EmptyState
          icon={<SearchIcon className="h-5 w-5" />}
          title="Search seeds"
          body={
            <>
              Type in the search box above, or press <kbd className="kbd">/</kbd>
            </>
          }
        />
      )}
    </PageShell>
  );
}

function Results({ q }: { q: string }) {
  const text = q.replace(/^@+/, '');
  const query = useQuery({
    queryKey: ['seed-search', text],
    queryFn: () => api.search({ q: text, page: 1, perPage: 24, filters: { bundleType: 'principal' } }),
    placeholderData: (prev) => prev,
  });

  if (query.isLoading) return <Loading />;
  if (query.isError) return <Unavailable />;
  const exact: SeedCardItem[] = (query.data?.exact ?? []).flatMap((hit) =>
    hit.kind === 'seed'
      ? [{ owner: hit.owner, name: hit.name, displayName: hit.displayName, description: hit.description }]
      : [],
  );
  const items: SeedCardItem[] = [
    ...exact,
    ...(query.data?.items ?? []).map((item) => ({ ...item, owner: item.namespace })),
  ];

  return (
    <>
      <PageHeader
        title={`“${q}”`}
        subtitle={`${items.length} seed${items.length === 1 ? '' : 's'}`}
      />
      <div className="mt-8">
        {items.length === 0 ? (
          <EmptyState icon={<SearchIcon className="h-5 w-5" />} title="No seeds match" />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((item) => (
              <SeedCard key={`${item.owner}/${item.name}`} item={item} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
