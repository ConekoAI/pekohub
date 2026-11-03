/**
 * Public peko page — `/@alice/ada`, the peko's ID (hub ADR-009). The
 * old share links `/peko/alice/ada` and `/p/alice/ada` redirect here.
 *
 * A public peko is reachable only by its exact ID: no page lists it.
 * Anyone with the link lands here. The website offers no chat: a visitor
 * opens the peko in Peko desktop (`peko://add-peko?url=…`) and messages it
 * there as their PekoHub account.
 */

import { createFileRoute, Link, notFound } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, MessageSquare } from 'lucide-react';
import { formatHubRef } from '@pekohub/shared';
import { api, desktopLinkFor, isApiError } from '~/lib/api';
import { PageShell } from '~/components/PageShell';
import { ProfileHeader } from '~/components/peko/ProfileHeader';
import { Loading, Unavailable } from '~/components/ui';

export const Route = createFileRoute('/@{$owner}/$name')({
  component: PublicPekoPage,
  head: ({ params }) => {
    const id = formatHubRef({ kind: 'peko', owner: params.owner, name: params.name });
    const title = `${params.name} (${id}) on PekoHub`;
    const description = `${params.owner}'s peko "${params.name}" on PekoHub. Open it in Peko to message it.`;
    const url = typeof window !== 'undefined' ? `${window.location.origin}/${id}` : `/${id}`;
    return {
      meta: [
        { title },
        { name: 'description', content: description },
        { property: 'og:type', content: 'profile' },
        { property: 'og:title', content: title },
        { property: 'og:description', content: description },
        { property: 'og:url', content: url },
        { name: 'twitter:card', content: 'summary' },
        { name: 'twitter:title', content: title },
        { name: 'twitter:description', content: description },
      ],
    };
  },
});

function PublicPekoPage() {
  const { owner, name: pekoName } = Route.useParams();

  const query = useQuery({
    queryKey: ['public-profile', owner, pekoName],
    queryFn: () => api.publicProfile(owner, pekoName),
    retry: false,
  });

  if (query.isLoading) {
    return (
      <PageShell width="narrow">
        <Loading />
      </PageShell>
    );
  }

  // A 404 means the peko isn't public (or doesn't exist) — a genuine
  // not-found. Anything else is a transport failure worth reporting
  // rather than masking.
  if (query.isError) {
    if (isApiError(query.error) && query.error.status === 404) throw notFound();
    return (
      <PageShell width="narrow">
        <Unavailable />
      </PageShell>
    );
  }

  if (!query.data) throw notFound();

  const profile = query.data;
  const id = formatHubRef({ kind: 'peko', owner, name: pekoName });
  const shareUrl = typeof window !== 'undefined' ? `${window.location.origin}/${id}` : `/${id}`;

  return (
    <PageShell width="narrow">
      <Link to="/@{$owner}" params={{ owner }} className="back-link">
        <ArrowLeft className="h-3.5 w-3.5" />@{owner}
      </Link>

      <ProfileHeader profile={profile} id={id} shareUrl={shareUrl} />

      <div className="mt-10 flex flex-wrap items-center gap-3 border-t border-ink-700 pt-8">
        <a href={desktopLinkFor(shareUrl)} className="btn-primary">
          <MessageSquare className="h-4 w-4" />
          Open in Peko
        </a>
        <Link to="/download" className="btn-ghost">
          Get Peko
        </Link>
      </div>
    </PageShell>
  );
}
