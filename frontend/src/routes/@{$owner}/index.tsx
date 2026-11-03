import { createFileRoute, notFound } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { formatHubRef } from '@pekohub/shared';
import { api, isApiError } from '~/lib/api';
import { formatDate } from '~/lib/format';
import { useSeedList } from '~/hooks/useSeed';
import { PageShell } from '~/components/PageShell';
import { SeedCard } from '~/components/SeedCard';
import { Avatar, CopyButton, Loading, SectionTitle, Unavailable } from '~/components/ui';

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
        <Loading />
      </PageShell>
    );
  }
  if (person.isError) {
    if (isApiError(person.error) && person.error.status === 404) throw notFound();
    return (
      <PageShell width="default">
        <Unavailable />
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
      <header className="flex flex-wrap items-center gap-5">
        <Avatar name={profile.displayName} src={profile.avatarUrl} size="xl" />
        <div className="min-w-0 flex-1">
          <h1 className="h-page truncate">{profile.displayName}</h1>
          <p className="mt-1 text-sm text-slate-500">
            {id} · joined {formatDate(profile.joinedAt)}
          </p>
        </div>
        <CopyButton value={pageUrl} label="Share" className="btn-secondary btn-sm flex-shrink-0" />
      </header>

      {items.length > 0 && (
        <section className="mt-14">
          <SectionTitle title="Seeds" />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((item) => (
              <SeedCard key={`${item.owner}/${item.name}`} item={item} />
            ))}
          </div>
        </section>
      )}
    </PageShell>
  );
}
