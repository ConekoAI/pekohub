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
import { Lock } from 'lucide-react';
import { z } from 'zod';
import { api } from '~/lib/api';
import { PageHeader, PageShell } from '~/components/PageShell';
import { CopyField, EmptyState, Loading, StatusDot } from '~/components/ui';
import { ReportButton } from '~/components/ReportButton';

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
        <Loading />
      </PageShell>
    );
  }
  if (group.isError || !group.data) {
    return (
      <PageShell width="narrow">
        <EmptyState
          icon={<Lock className="h-5 w-5" />}
          title="This group isn't open to you"
          body="Ask its owner for an invite link."
        />
      </PageShell>
    );
  }
  const g = group.data;
  return (
    <PageShell width="narrow">
      <PageHeader
        title={g.name}
        subtitle={
          <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>{g.visibility === 'public' ? 'Public group' : 'Invite-only group'}</span>
            <span aria-hidden>·</span>
            <span>
              {g.owner.name ?? 'Someone'}
              {g.owner.handle && <span className="text-slate-500"> {g.owner.handle}</span>}
            </span>
            <span aria-hidden>·</span>
            <span className="inline-flex items-center gap-1.5">
              <StatusDot status={g.homeOnline ? 'online' : 'offline'} />
              {g.homeOnline ? 'online' : 'offline'}
            </span>
          </span>
        }
      />
      <section className="mt-10 space-y-4" data-testid="group-join">
        <h2 className="h-section">Join in Peko</h2>
        <p className="text-sm text-slate-400">
          Groups → Join a group, then paste this {invite ? 'link' : 'ID'}.{' '}
          <Link to="/download" className="link">
            Get Peko
          </Link>
        </p>
        <CopyField value={invite ? link : g.id} />
      </section>
      <div className="mt-10 border-t border-ink-700 pt-6">
        <ReportButton target={g.id} className="-ml-2.5" />
      </div>
    </PageShell>
  );
}
