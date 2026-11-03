import { Link, createFileRoute, useNavigate, useSearch as useRouteSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Boxes, Plus } from 'lucide-react';
import { z } from 'zod';
import { api } from '~/lib/api';
import { PageHeader, PageShell } from '~/components/PageShell';
import { SearchBar } from '~/components/SearchBar';
import { SeedCard, type SeedCardItem } from '~/components/SeedCard';
import { EmptyState, Loading, Unavailable } from '~/components/ui';
import { useSeedList } from '~/hooks/useSeed';

/**
 * Seed directory.
 *
 * A seed is the DNA a peko grows from (runtime ADR-060): a stripped
 * `principal.toml`, published here as text and named `<owner>/<name>`.
 * The default listing is newest first (`GET /v1/seeds`); a typed query
 * goes to full-text search (`GET /v1/search`). This is the website's only
 * search: it finds seeds, never people or pekos — looking those up by ID
 * is the desktop's job. A leading `@` is dropped, so `@alice` finds
 * alice's seeds, and an exact seed ID (`alice/ada`) comes first.
 */

const searchSchema = z.object({ q: z.string().optional() });

export const Route = createFileRoute('/seeds/')({
  head: () => ({ meta: [{ title: 'Seeds — PekoHub' }] }),
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
        title="Seeds"
        action={
          <Link to="/seeds/new" className="btn-primary btn-sm">
            <Plus className="h-3.5 w-3.5" />
            Publish a seed
          </Link>
        }
      />

      <div className="mt-8 max-w-xl">
        <SearchBar initialQuery={q} onSearch={handleSearch} placeholder="Search seeds" />
      </div>

      <div className="mt-8">{q ? <SearchResults q={q} /> : <Listing />}</div>
    </PageShell>
  );
}

function SeedGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{children}</div>;
}

function SearchResults({ q }: { q: string }) {
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

  if (items.length === 0) {
    return <EmptyState icon={<Boxes className="h-5 w-5" />} title={`No seeds match “${q}”`} />;
  }
  return (
    <SeedGrid>
      {items.map((item) => (
        <SeedCard key={`${item.owner}/${item.name}`} item={item} />
      ))}
    </SeedGrid>
  );
}

function Listing() {
  const list = useSeedList();

  if (list.isLoading) return <Loading />;
  if (list.isError) return <Unavailable />;
  const items = list.data?.items ?? [];

  if (items.length === 0) {
    return (
      <EmptyState
        icon={<Boxes className="h-5 w-5" />}
        title="No seeds yet"
        body={
          <>
            Export one with <code className="code-inline">peko seed &lt;name&gt;</code>
          </>
        }
      />
    );
  }

  return (
    <SeedGrid>
      {items.map((item) => (
        <SeedCard key={`${item.owner}/${item.name}`} item={item} />
      ))}
    </SeedGrid>
  );
}
