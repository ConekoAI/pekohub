import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, Boxes, Loader2, Search as SearchIcon } from 'lucide-react';
import type { ExactHit } from '@pekohub/shared';
import { api } from '~/lib/api';
import { PageHeader, PageShell } from '~/components/PageShell';
import { SearchBar } from '~/components/SearchBar';
import { SeedCard } from '~/components/SeedCard';
import { Avatar, Badge, EmptyState, ErrorNote, StatusPill } from '~/components/ui';

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
      <PageHeader
        eyebrow="search"
        title="Search"
        description={
          <>
            Find a person or a peko by its exact ID — <code className="code-inline">@alice</code>,{' '}
            <code className="code-inline">@alice/ada</code> — open a group by its number, or search seeds by name and
            description.
          </>
        }
      />
      <div className="mt-8 max-w-2xl">
        <SearchBar
          initialQuery={q ?? ''}
          onSearch={(query) =>
            // A group's ID is a bare number (ADR-092 D5): it opens the group's page.
            /^[0-9]{6,20}$/.test(query.trim())
              ? void navigate({ to: '/g/$id', params: { id: query.trim() }, search: {} })
              : void navigate({ to: '/search', search: { q: query || undefined } })
          }
          placeholder="@alice/ada, alice/ada, or words"
          size="md"
          autoFocus={!q}
        />
      </div>
      <div className="mt-8">{q ? <Results q={q} /> : <Hint />}</div>
    </PageShell>
  );
}

function Hint() {
  return (
    <EmptyState
      icon={<SearchIcon className="h-5 w-5" />}
      title="People and pekos are found by their ID"
      body={
        <>
          PekoHub lists no one: ask for someone&apos;s ID, like <code className="code-inline">@alice</code> or{' '}
          <code className="code-inline">@alice/ada</code>. Seeds, which you download, can be searched —{' '}
          <Link to="/seeds" className="text-peko-300 hover:text-peko-200">
            or browse them all
          </Link>
          .
        </>
      }
    />
  );
}

function Results({ q }: { q: string }) {
  const query = useQuery({
    queryKey: ['search', q],
    queryFn: () => api.search({ q, page: 1, perPage: 24, filters: { bundleType: 'principal' } }),
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
  if (query.isError || !query.data) {
    return <ErrorNote>PekoHub isn&apos;t answering right now. Try again in a moment.</ErrorNote>;
  }

  const { exact, items, queryKind } = query.data;
  const byId = queryKind === 'person' || queryKind === 'peko';

  if (exact.length === 0 && items.length === 0) {
    return (
      <EmptyState
        icon={<Boxes className="h-5 w-5" />}
        title={byId ? `No one public is ${q}` : 'Nothing matched'}
        body={
          byId
            ? 'People and pekos are found only by their exact ID. Check the spelling, or ask its owner whether it is public.'
            : 'Seed names and descriptions are searched. Try a shorter query — people and pekos are found only by their exact ID, like @alice/ada.'
        }
      />
    );
  }

  return (
    <div className="space-y-8">
      {exact.length > 0 && (
        <section>
          <p className="eyebrow">exact match</p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {exact.map((hit) => (
              <ExactCard key={`${hit.kind}:${hit.id}`} hit={hit} />
            ))}
          </div>
        </section>
      )}
      {!byId && items.length > 0 && (
        <section>
          <p className="eyebrow">
            {query.data.total} seed{query.data.total === 1 ? '' : 's'} · “{q}”
          </p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
        <Link to="/@{$owner}" params={{ owner: hit.handle }} className="card card-hover group flex items-center gap-3 p-5">
          <Avatar name={hit.displayName} src={hit.avatarUrl} size="md" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-[15px] font-semibold text-slate-100">{hit.displayName}</h3>
              <Badge tone="neutral">person</Badge>
            </div>
            <p className="truncate font-mono text-2xs text-slate-500">{hit.id}</p>
          </div>
          <ArrowUpRight className="h-4 w-4 flex-shrink-0 text-slate-600 group-hover:text-peko-300" />
        </Link>
      );
    case 'peko':
      return (
        <Link
          to="/@{$owner}/$name"
          params={{ owner: hit.owner, name: hit.name }}
          className="card card-hover group flex flex-col p-5"
        >
          <header className="flex items-start gap-3">
            <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border border-peko-400/20 bg-peko-400/[0.07] text-base">
              {hit.avatar ?? <span className="font-mono text-xs text-peko-300">{hit.name.slice(0, 2)}</span>}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h3 className="truncate text-[15px] font-semibold text-slate-100">{hit.displayName}</h3>
                <Badge tone="peko">peko</Badge>
              </div>
              <p className="truncate font-mono text-2xs text-slate-500">{hit.id}</p>
            </div>
            <StatusPill status={hit.status} />
          </header>
          {hit.description && (
            <p className="mt-3 line-clamp-3 text-[13px] leading-relaxed text-slate-400">{hit.description}</p>
          )}
        </Link>
      );
    case 'seed':
      return (
        <Link
          to="/$owner/$name"
          params={{ owner: hit.owner, name: hit.id.slice(hit.owner.length + 1) }}
          className="card card-hover group flex flex-col p-5"
        >
          <div className="flex items-center gap-2">
            <h3 className="truncate text-[15px] font-semibold text-slate-100">{hit.displayName ?? hit.name}</h3>
            <Badge tone="iris">seed</Badge>
          </div>
          <p className="truncate font-mono text-2xs text-slate-500">
            {hit.owner}/{hit.name} · v{hit.version}
          </p>
          {hit.description && (
            <p className="mt-3 line-clamp-3 text-[13px] leading-relaxed text-slate-400">{hit.description}</p>
          )}
        </Link>
      );
  }
}
