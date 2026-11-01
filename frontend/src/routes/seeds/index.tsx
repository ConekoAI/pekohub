import { Link, createFileRoute, useNavigate, useSearch as useRouteSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Boxes, Loader2, Plus } from 'lucide-react';
import { z } from 'zod';
import { api } from '~/lib/api';
import { PageHeader, PageShell } from '~/components/PageShell';
import { SearchBar } from '~/components/SearchBar';
import { SeedCard } from '~/components/SeedCard';
import { EmptyState, ErrorNote } from '~/components/ui';
import { useSeedList } from '~/hooks/useSeed';

/**
 * Seed directory.
 *
 * A seed is the DNA a peko grows from (runtime ADR-060): a stripped
 * `principal.toml`, published here as text and named `<owner>/<name>`.
 * The default listing is newest first (`GET /v1/seeds`); a typed query
 * goes to full-text search (`GET /v1/search`).
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
        eyebrow="registry"
        title="Seeds"
        description={
          <>
            A seed is what a peko grows from: its definition, without its identity, memory or
            keys. Download one and grow your own with{' '}
            <code className="code-inline">peko create -s</code>.
          </>
        }
        action={
          <Link to="/seeds/new" className="btn-primary btn-sm">
            <Plus className="h-3.5 w-3.5" />
            Publish a seed
          </Link>
        }
      />

      <div className="mt-8 max-w-2xl">
        <SearchBar
          initialQuery={q}
          onSearch={handleSearch}
          placeholder="Search seeds by name or description…"
          size="md"
        />
      </div>

      <div className="mt-8">{q ? <SearchResults q={q} /> : <Listing />}</div>
    </PageShell>
  );
}

function Loading({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center gap-2.5 py-24 text-sm text-slate-500">
      <Loader2 className="h-4 w-4 animate-spin text-peko-400" />
      {label}
    </div>
  );
}

function Unavailable() {
  return <ErrorNote>PekoHub isn&apos;t answering right now. Try again in a moment.</ErrorNote>;
}

function SearchResults({ q }: { q: string }) {
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: ['seed-search', q],
    queryFn: () => api.search({ q, page: 1, perPage: 24, filters: { bundleType: 'principal' } }),
    placeholderData: (prev) => prev,
  });

  if (query.isLoading) return <Loading label="Searching…" />;
  if (query.isError) return <Unavailable />;
  const items = query.data?.items ?? [];

  return (
    <section>
      <div className="flex items-baseline justify-between gap-4">
        <p className="eyebrow">
          {items.length} result{items.length === 1 ? '' : 's'} · “{q}”
        </p>
        <button onClick={() => void navigate({ to: '/seeds', search: {} })} className="btn-ghost btn-sm">
          Clear
        </button>
      </div>
      {items.length === 0 ? (
        <div className="mt-4">
          <EmptyState
            icon={<Boxes className="h-5 w-5" />}
            title="No seeds matched"
            body="Names and descriptions are searched. Try a shorter query, or browse all seeds."
          />
        </div>
      ) : (
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item) => (
            <SeedCard
              key={`${item.namespace}/${item.name}`}
              item={{ ...item, owner: item.namespace }}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function Listing() {
  const list = useSeedList();

  if (list.isLoading) return <Loading label="Loading seeds…" />;
  if (list.isError) return <Unavailable />;
  const items = list.data?.items ?? [];

  if (items.length === 0) {
    return (
      <EmptyState
        icon={<Boxes className="h-5 w-5" />}
        title="No seeds yet"
        body={
          <>
            Export one from a peko with <code className="code-inline">peko seed &lt;name&gt;</code>,
            then <Link to="/seeds/new" className="text-peko-300 hover:text-peko-200">publish it</Link>.
          </>
        }
      />
    );
  }

  return (
    <section>
      <p className="eyebrow">
        {list.data!.total} seed{list.data!.total === 1 ? '' : 's'} · newest first
      </p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((item) => (
          <SeedCard key={`${item.owner}/${item.name}`} item={item} />
        ))}
      </div>
    </section>
  );
}
