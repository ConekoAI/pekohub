/**
 * `/g/<id>` — a group's page (runtime ADR-092 D5).
 *
 * A group lives on its owner's computer; PekoHub only knows its ID, name
 * and owner. A public group shows to anyone with the ID; an invite-only
 * one only with an invite link (`?invite=…`). Joining happens in Peko: the
 * link (or the ID, for a public group) goes into Groups → Join a group.
 */

import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Hash, Lock, Users } from 'lucide-react';
import { z } from 'zod';
import { api } from '~/lib/api';
import { PageHeader, PageShell } from '~/components/PageShell';
import { CopyButton, EmptyState, Spinner } from '~/components/ui';

const searchSchema = z.object({ invite: z.string().optional() });

export const Route = createFileRoute('/g/$id')({
  validateSearch: searchSchema,
  component: GroupPage,
  head: () => ({ meta: [{ title: 'A group on PekoHub' }] }),
});

function GroupPage() {
  const { id } = Route.useParams();
  const { invite } = Route.useSearch();
  const group = useQuery({
    queryKey: ['group', id, invite ?? null],
    queryFn: () => api.getGroup(id, invite),
    retry: false,
  });
  const link = typeof window === 'undefined' ? '' : window.location.href;

  if (group.isLoading) {
    return (
      <PageShell width="narrow">
        <div className="flex justify-center py-24">
          <Spinner className="h-5 w-5" />
        </div>
      </PageShell>
    );
  }
  if (group.isError || !group.data) {
    return (
      <PageShell width="narrow">
        <div className="mt-16">
          <EmptyState
            icon={<Lock className="h-5 w-5" />}
            title="This group isn't open to you"
            body="It may be invite-only: ask its owner for an invite link. A group's ID alone opens only a public group."
          />
        </div>
      </PageShell>
    );
  }
  const g = group.data;
  return (
    <PageShell width="narrow">
      <PageHeader
        eyebrow={g.visibility === 'public' ? 'public group' : 'invite-only group'}
        title={g.name}
        description={
          <>
            Owned by {g.owner.name ?? 'someone'}
            {g.owner.handle && (
              <>
                {' '}
                (<span className="font-mono">{g.owner.handle}</span>)
              </>
            )}
            . Its messages live on its owner&apos;s computer
            {g.homeOnline ? ', which is online now.' : ', which is offline right now; you can still join, and messages arrive when it is back.'}
          </>
        }
      />
      <section className="panel mt-8 space-y-4 p-6" data-testid="group-join">
        <div className="flex items-center gap-2 text-sm font-medium text-slate-100">
          <Users className="h-4 w-4" />
          Join in Peko
        </div>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-300">
          <li>
            Open Peko on your computer and sign in to PekoHub (
            <Link to="/download" className="text-peko-300 hover:text-peko-200">
              get Peko
            </Link>
            ).
          </li>
          <li>In Groups, choose Join a group, and paste this {invite ? 'link' : 'ID'}.</li>
        </ol>
        <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/20 p-2">
          <Hash className="h-4 w-4 shrink-0 text-slate-500" />
          <code className="min-w-0 flex-1 truncate font-mono text-xs text-slate-300">{invite ? link : g.id}</code>
          <CopyButton value={invite ? link : g.id} />
        </div>
      </section>
    </PageShell>
  );
}
