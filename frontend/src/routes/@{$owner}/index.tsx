import { createFileRoute, Link, notFound } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Sprout } from 'lucide-react';
import { formatHubRef } from '@pekohub/shared';
import { api, isApiError } from '~/lib/api';
import { formatDate } from '~/lib/format';
import { useSeedList } from '~/hooks/useSeed';
import { PageShell } from '~/components/PageShell';
import { SeedCard } from '~/components/SeedCard';
import { Avatar, CopyButton, EmptyState, ErrorNote, Spinner } from '~/components/ui';

/**
 * A person's page — `/@alice`, their ID (hub ADR-009).
 *
 * Reached only by the exact handle: no page lists people. It shows who
 * they are and the seeds they published — never their pekos, which are
 * reachable only by their own IDs.
 */
export const Route = createFileRoute('/@{$owner}/')({
  head: ({ params }) => ({ meta: [{ title: `@${params.owner} on PekoHub` }] }),
  component: PersonPage,
});

function PersonPage() {
  const { owner } = Route.useParams();
  const person = useQuery({
    queryKey: ['person', owner],
    queryFn: () => api.person(owner),
    retry: false,
  });
  const seeds = useSeedList(1, 24, owner);

  if (person.isLoading) {
    return (
      <PageShell width="default">
        <div className="flex items-center justify-center gap-2.5 py-32 text-sm text-slate-500">
          <Spinner className="h-4 w-4" />
          Looking up @{owner}…
        </div>
      </PageShell>
    );
  }
  if (person.isError) {
    if (isApiError(person.error) && person.error.status === 404) throw notFound();
    return (
      <PageShell width="default">
        <ErrorNote>PekoHub isn&apos;t answering right now. Try again in a moment.</ErrorNote>
      </PageShell>
    );
  }
  if (!person.data) throw notFound();

  const profile = person.data;
  const id = formatHubRef({ kind: 'person', handle: profile.handle });
  const pageUrl = typeof window !== 'undefined' ? `${window.location.origin}/${id}` : `/${id}`;
  const items = seeds.data?.items ?? [];

  return (
    <PageShell width="default">
      <header className="panel flex flex-wrap items-center gap-4 px-6 py-6">
        <Avatar name={profile.displayName} src={profile.avatarUrl} size="lg" />
        <div className="min-w-0 flex-1">
          <h1 className="display truncate text-2xl">{profile.displayName}</h1>
          <p className="mt-1 font-mono text-2xs text-slate-500">
            {id} · on PekoHub since {formatDate(profile.joinedAt)}
          </p>
        </div>
        <CopyButton value={pageUrl} label="Share" className="btn-secondary btn-sm flex-shrink-0" />
      </header>

      <section className="mt-10">
        <p className="eyebrow">seeds</p>
        <div className="mt-4">
          {seeds.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <Spinner className="h-4 w-4" />
              Loading seeds…
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              icon={<Sprout className="h-5 w-5" />}
              title="No seeds yet"
              body={
                <>
                  {profile.displayName} hasn&apos;t published a seed.{' '}
                  <Link to="/seeds" className="text-peko-300 hover:text-peko-200">
                    Browse all seeds
                  </Link>
                  .
                </>
              }
            />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {items.map((item) => (
                <SeedCard key={`${item.owner}/${item.name}`} item={item} />
              ))}
            </div>
          )}
        </div>
      </section>
    </PageShell>
  );
}
