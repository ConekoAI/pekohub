/**
 * Public peko page — `/peko/$owner/$pekoName` (ADR-005 §1 canonical
 * share URL; `/p/$owner/$name` redirects here).
 *
 * Anyone with the link lands here. The website offers no chat: a visitor
 * opens the peko in Peko desktop (`peko://add-peko?url=…`), which adds it
 * as a contact and messages it over the visitor's own runtime.
 */

import { createFileRoute, Link, notFound } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Download, MessageSquare } from 'lucide-react';
import { api, desktopLinkFor, isApiError } from '~/lib/api';
import { PageShell } from '~/components/PageShell';
import { ProfileHeader } from '~/components/peko/ProfileHeader';
import { ErrorNote, Spinner } from '~/components/ui';

/** Where to get the desktop app when the deep link has nothing to open. */
export const DESKTOP_DOWNLOAD_URL = 'https://github.com/ConekoAI/peko-desktop/releases/latest';

export const Route = createFileRoute('/peko/$owner/$pekoName')({
  component: PublicPekoPage,
  head: ({ params }) => {
    const title = `${params.pekoName} — ${params.owner} on PekoHub`;
    const description = `${params.owner}'s peko "${params.pekoName}" on PekoHub. Open it in Peko to message it.`;
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
        { name: 'twitter:card', content: 'summary' },
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
          Looking up {pekoName}…
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
          <p className="font-medium">Could not load this peko</p>
          <p className="mt-1 text-rose-200/70">
            PekoHub is not answering right now. Try again in a moment.
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
      : `/peko/${owner}/${pekoName}`;

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

        <section className="panel px-6 py-5">
          <h2 className="text-[15px] font-semibold tracking-tight text-slate-100">
            Message {profile.liveInstance.publicName}
          </h2>
          <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-slate-400">
            Pekos talk over Peko. Open this one in the desktop app and it joins your contacts;
            your messages travel from your own runtime, and the conversation stays on your machine.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-2.5">
            <a href={desktopLinkFor(shareUrl)} className="btn-primary btn-sm">
              <MessageSquare className="h-3.5 w-3.5" />
              Open in Peko
            </a>
            <a
              href={DESKTOP_DOWNLOAD_URL}
              target="_blank"
              rel="noreferrer"
              className="btn-secondary btn-sm"
            >
              <Download className="h-3.5 w-3.5" />
              Get Peko desktop
            </a>
          </div>
        </section>
      </div>
    </PageShell>
  );
}
