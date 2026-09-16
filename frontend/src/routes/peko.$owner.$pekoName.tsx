/**
 * Public peko page — `/peko/$owner/$pekoName` (ADR-005 §1 canonical
 * share URL; `/p/$owner/$name` redirects here).
 *
 * Anyone with the link lands here. The backend mints a signed visitor
 * cookie on first load so a returning browser resumes its own thread.
 * Link previews use the `head` block below; real OG image rendering is
 * still a placeholder.
 */

import { createFileRoute, Link, notFound } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft } from 'lucide-react';
import { api, isApiError } from '~/lib/api';
import { PageShell } from '~/components/PageShell';
import { ProfileHeader } from '~/components/public-chat/ProfileHeader';
import { PublicChatPanel } from '~/components/public-chat/PublicChatPanel';
import { ErrorNote, Spinner } from '~/components/ui';

export const Route = createFileRoute('/peko/$owner/$pekoName')({
  component: PublicPekoPage,
  head: ({ params }) => {
    const title = `${params.pekoName} — ${params.owner} on PekoHub`;
    const description = `Chat with ${params.owner}'s peko "${params.pekoName}" — a public peko, reachable straight from the browser.`;
    const url =
      typeof window !== 'undefined'
        ? `${window.location.origin}/peko/${params.owner}/${params.pekoName}`
        : `/peko/${params.owner}/${params.pekoName}`;
    return {
      meta: [
        { title },
        { name: 'description', content: description },
        { property: 'og:type', content: 'profile' },
        { property: 'og:title', content: title },
        { property: 'og:description', content: description },
        { property: 'og:url', content: url },
        { name: 'twitter:card', content: 'summary_large_image' },
        { name: 'twitter:title', content: title },
        { name: 'twitter:description', content: description },
      ],
    };
  },
});

function PublicPekoPage() {
  const { owner, pekoName } = Route.useParams();

  const query = useQuery({
    queryKey: ['public-profile', owner, pekoName],
    queryFn: () => api.publicProfile(owner, pekoName),
    retry: false,
  });

  if (query.isLoading) {
    return (
      <PageShell width="narrow">
        <div className="flex flex-col items-center justify-center gap-3 py-32 text-sm text-slate-500">
          <Spinner className="h-5 w-5" />
          Waking up {pekoName}…
        </div>
      </PageShell>
    );
  }

  // A 404 means the peko is neither `public` nor `unlisted` (or does
  // not exist) — that is a genuine not-found. Anything else is a
  // transport failure worth reporting rather than masking.
  if (query.isError) {
    if (isApiError(query.error) && query.error.status === 404) throw notFound();
    return (
      <PageShell width="narrow">
        <ErrorNote>
          <p className="font-medium">Could not reach this peko</p>
          <p className="mt-1 text-rose-200/70">
            {query.error instanceof Error ? query.error.message : 'Unknown error'}
          </p>
        </ErrorNote>
      </PageShell>
    );
  }

  if (!query.data) throw notFound();

  const profile = query.data;
  const shareUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/peko/${owner}/${pekoName}`
      : undefined;

  return (
    <PageShell width="narrow">
      <Link
        to="/pekos"
        className="inline-flex items-center gap-1.5 font-mono text-2xs text-slate-500 transition-colors hover:text-peko-300"
      >
        <ArrowLeft className="h-3 w-3" />
        all pekos
      </Link>

      <div className="mt-5 space-y-4">
        <ProfileHeader profile={profile} shareUrl={shareUrl} />
        <PublicChatPanel profile={profile} />
      </div>

      <p className="mt-6 flex items-start gap-2 font-mono text-2xs leading-relaxed text-slate-600">
        <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0 text-slate-700" />
        <span>
          You are talking to an autonomous actor running on someone else&apos;s machine. Responses
          are generated and may be wrong — don&apos;t share secrets.
        </span>
      </p>
    </PageShell>
  );
}
