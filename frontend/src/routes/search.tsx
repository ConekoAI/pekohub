import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Search as SearchIcon } from 'lucide-react';
import type { ExactHit } from '@pekohub/shared';
import { api } from '~/lib/api';
import { PageHeader, PageShell } from '~/components/PageShell';
import { SearchBar } from '~/components/SearchBar';
import { SeedCard } from '~/components/SeedCard';
import { Avatar, Badge, EmptyState, Loading, StatusPill, Tile, Unavailable } from '~/components/ui';

/**
 * The one search — people, pekos and seeds (hub ADR-009).
 *
 * The query is read as an ID first. `@alice` and `@alice/ada` find that
 * person or public peko, exactly, and nothing else: people and pekos are
 * never listed or searched by text. Anything else searches seeds; a seed
 * ID, `alice/ada`, puts that seed (and a public peko `@alice/ada`) first.
 * Each result says what it is.
 */
export const Route = createFileRoute('/search')({
  head: () => ({ meta: [{ title: 'Search — PekoHub' }] }),
  validateSearch: (search: Record<string, unknown>) => ({
    q: typeof search.q === 'string' && search.q.trim() ? search.q.trim() : undefined,
  }),
  component: SearchPage,
});

function SearchPage() {
  const { q } = Route.useSearch();
  const navigate = useNavigate();

  return (
    <PageShell width="wide">
      <PageHeader title="Search" />
      <div className="mt-8 max-w-xl">
        <SearchBar
          initialQuery={q ?? ''}
          onSearch={(query) =>
            // A group's ID is a bare number (ADR-092 D5): it opens the group's page.
            /^[0-9]{6,20}$/.test(query.trim())
              ? void navigate({ to: '/g/$id', params: { id: query.trim() }, search: {} })
              : void navigate({ to: '/search', search: { q: query || undefined } })
          }
          placeholder="@alice, @alice/ada, or a seed"
          autoFocus={!q}
        />
      </div>
      <div className="mt-10">{q ? <Results q={q} /> : <Hint />}</div>
    </PageShell>
  );
}

function Hint() {
  return (
    <p className="text-sm text-slate-500">
      People and pekos are found by their exact ID. Seeds by name —{' '}
      <Link to="/seeds" className="link">
        browse all
      </Link>
      .
    </p>
  );
}

function Results({ q }: { q: string }) {
  const query = useQuery({
    queryKey: ['search', q],
    queryFn: () => api.search({ q, page: 1, perPage: 24, filters: { bundleType: 'principal' } }),
    placeholderData: (prev) => prev,
  });

  if (query.isLoading) return <Loading />;
  if (query.isError || !query.data) return <Unavailable />;

  const { exact, items, queryKind } = query.data;
  const byId = queryKind === 'person' || queryKind === 'peko';

  if (exact.length === 0 && items.length === 0) {
    return (
      <EmptyState
        icon={<SearchIcon className="h-5 w-5" />}
        title={byId ? `No one public is ${q}` : 'Nothing matched'}
        body={byId ? 'IDs must match exactly.' : undefined}
      />
    );
  }

  return (
    <div className="space-y-10">
      {exact.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {exact.map((hit) => (
            <ExactCard key={`${hit.kind}:${hit.id}`} hit={hit} />
          ))}
        </div>
      )}
      {!byId && items.length > 0 && (
        <section>
          {exact.length > 0 && <h2 className="h-section mb-4">Seeds</h2>}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((item) => (
              <SeedCard key={`${item.namespace}/${item.name}`} item={{ ...item, owner: item.namespace }} showKind />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function ExactCard({ hit }: { hit: ExactHit }) {
  switch (hit.kind) {
    case 'person':
      return (
        <Link to="/@{$owner}" params={{ owner: hit.handle }} className="card card-hover flex items-center gap-3 p-5">
          <Avatar name={hit.displayName} src={hit.avatarUrl} size="md" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-[15px] font-medium text-slate-100">{hit.displayName}</h3>
              <Badge>person</Badge>
            </div>
            <p className="truncate text-xs text-slate-500">{hit.id}</p>
          </div>
        </Link>
      );
    case 'peko':
      return (
        <Link
          to="/@{$owner}/$name"
          params={{ owner: hit.owner, name: hit.name }}
          className="card card-hover flex flex-col p-5"
        >
          <header className="flex items-center gap-3">
            <Tile avatar={hit.avatar} name={hit.name} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h3 className="truncate text-[15px] font-medium text-slate-100">{hit.displayName}</h3>
                <Badge tone="accent">peko</Badge>
              </div>
              <p className="truncate text-xs text-slate-500">{hit.id}</p>
            </div>
          </header>
          {hit.description && (
            <p className="mt-3 line-clamp-2 text-[13px] leading-relaxed text-slate-400">{hit.description}</p>
          )}
          <div className="mt-auto pt-4">
            <StatusPill status={hit.status} />
          </div>
        </Link>
      );
    case 'seed':
      return (
        <Link
          to="/$owner/$name"
          params={{ owner: hit.owner, name: hit.id.slice(hit.owner.length + 1) }}
          className="card card-hover flex flex-col p-5"
        >
          <div className="flex items-center gap-2">
            <h3 className="truncate text-[15px] font-medium text-slate-100">{hit.displayName ?? hit.name}</h3>
            <Badge>seed</Badge>
          </div>
          <p className="truncate text-xs text-slate-500">
            {hit.owner}/{hit.name} · {hit.version}
          </p>
          {hit.description && (
            <p className="mt-3 line-clamp-2 text-[13px] leading-relaxed text-slate-400">{hit.description}</p>
          )}
        </Link>
      );
  }
}
