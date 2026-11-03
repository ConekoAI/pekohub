/**
 * `/admin` — the moderation queue (gap map B2/B3), for moderators and
 * admins only; anyone else finds no page here.
 *
 * Reports arrive from the Report buttons on seed, peko, person and group
 * pages. Each open report offers the actions that fit what it names: hide a
 * seed or yank the reported version, take a peko off PekoHub, suspend the
 * account answerable for it, or dismiss it. Acting closes the report; every
 * action is in the `moderation` audit log with the reason given here.
 */

import { createFileRoute, Link, notFound } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { parseHubRef } from '@pekohub/shared';
import { api, REPORT_REASONS, type ModerationReport, type ReportStatus } from '~/lib/api';
import { useAuth } from '~/hooks/useAuth';
import { formatDate, relativeTime } from '~/lib/format';
import { PageHeader, PageShell } from '~/components/PageShell';
import { Badge, EmptyState, ErrorNote, Loading, Unavailable } from '~/components/ui';
import { SignInModal } from '~/components/SignInModal';

export const Route = createFileRoute('/admin')({
  head: () => ({ meta: [{ title: 'Moderation — PekoHub' }] }),
  component: ModerationPage,
});

const TABS: Array<{ status: ReportStatus; label: string }> = [
  { status: 'open', label: 'Open' },
  { status: 'actioned', label: 'Actioned' },
  { status: 'dismissed', label: 'Dismissed' },
];

function ModerationPage() {
  const { user, isLoading } = useAuth();
  const [signInOpen, setSignInOpen] = useState(false);

  if (isLoading) {
    return (
      <PageShell width="default">
        <Loading />
      </PageShell>
    );
  }
  if (!user) {
    return (
      <div className="mx-auto max-w-sm animate-fade-up px-5 py-32 text-center">
        <h1 className="h-page">Sign in to continue</h1>
        <button onClick={() => setSignInOpen(true)} className="btn-primary mt-6">
          Sign in
        </button>
        <SignInModal isOpen={signInOpen} onClose={() => setSignInOpen(false)} />
      </div>
    );
  }
  if (user.role !== 'moderator' && user.role !== 'admin') throw notFound();
  return <Queue />;
}

function Queue() {
  const [status, setStatus] = useState<ReportStatus>('open');
  const reports = useQuery({
    queryKey: ['admin', 'reports', status],
    queryFn: () => api.listReports(status),
  });

  return (
    <PageShell width="default">
      <PageHeader title="Moderation" subtitle="Reports from people on PekoHub, newest first." />
      <nav className="mt-8 flex items-center gap-6 border-b border-ink-700" aria-label="Report status">
        {TABS.map((tab) => (
          <button
            key={tab.status}
            type="button"
            onClick={() => setStatus(tab.status)}
            className={status === tab.status ? 'tab tab-active' : 'tab'}
            aria-pressed={status === tab.status}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <div className="mt-8">
        {reports.isLoading ? (
          <Loading />
        ) : reports.isError ? (
          <Unavailable />
        ) : (reports.data?.reports.length ?? 0) === 0 ? (
          <EmptyState
            icon={<ShieldCheck className="h-5 w-5" />}
            title={status === 'open' ? 'Nothing to review' : 'No reports here'}
            body={status === 'open' ? 'New reports show up here.' : undefined}
          />
        ) : (
          <ul className="space-y-4">
            {reports.data!.reports.map((report) => (
              <li key={report.id}>
                <ReportCard report={report} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </PageShell>
  );
}

const REASON_LABEL = Object.fromEntries(REPORT_REASONS.map((r) => [r.value, r.label])) as Record<string, string>;

/** The page a report's target lives on. */
function TargetLink({ report }: { report: ModerationReport }) {
  const label = <span className="font-mono text-[13px]">{report.target}</span>;
  if (report.targetKind === 'group') {
    return (
      <Link to="/g/$id" params={{ id: report.target }} className="link">
        {label}
      </Link>
    );
  }
  return (
    <a href={`/${report.target}`} className="link">
      {label}
    </a>
  );
}

function ReportCard({ report }: { report: ModerationReport }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = parseHubRef(report.target);
  const seed = ref?.kind === 'seed' ? ref : null;
  const action = { reason: reason.trim() || undefined, reportId: report.id };

  const run = async (confirmText: string | null, act: () => Promise<unknown>) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    setError(null);
    try {
      await act();
      await queryClient.invalidateQueries({ queryKey: ['admin', 'reports'] });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That didn’t go through');
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="card p-5" data-testid="report">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Badge>{report.targetKind}</Badge>
        <TargetLink report={report} />
        <span className="text-sm text-slate-300">{REASON_LABEL[report.reason] ?? report.reason}</span>
        {report.targetRemoved && <Badge tone="danger">removed</Badge>}
        {report.account?.suspended && <Badge tone="danger">@{report.account.handle} suspended</Badge>}
        <span className="ml-auto text-xs text-slate-500" title={formatDate(report.createdAt)}>
          {report.reporter ? `@${report.reporter.handle} · ` : ''}
          {relativeTime(report.createdAt)}
        </span>
      </header>

      {report.note && <p className="mt-3 whitespace-pre-wrap text-sm text-slate-300">{report.note}</p>}

      {report.status !== 'open' && (
        <p className="mt-3 text-xs text-slate-500">
          {report.status === 'actioned' ? 'Actioned' : 'Dismissed'}
          {report.resolvedBy && ` by @${report.resolvedBy.handle}`}
          {report.resolvedAt && ` ${relativeTime(report.resolvedAt)}`}
          {report.resolution && ` — ${report.resolution}`}
        </p>
      )}

      {error && (
        <div className="mt-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      {report.status === 'open' ? (
        <div className="mt-4 space-y-3 border-t border-ink-700 pt-4">
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Reason, for the audit log"
            aria-label="Reason"
            maxLength={1000}
            className="input text-sm"
          />
          <div className="flex flex-wrap gap-2">
            {seed && (
              <button
                type="button"
                disabled={busy}
                className="btn-danger btn-sm"
                onClick={() =>
                  void run(`Hide ${seed.owner}/${seed.name} and every version?`, () =>
                    api.hideSeed(seed.owner, seed.name, true, action),
                  )
                }
              >
                Hide seed
              </button>
            )}
            {seed?.version && (
              <button
                type="button"
                disabled={busy}
                className="btn-secondary btn-sm"
                onClick={() =>
                  void run(`Yank v${seed.version}?`, () =>
                    api.yankSeedVersion(seed.owner, seed.name, seed.version!, true, action),
                  )
                }
              >
                Yank v{seed.version}
              </button>
            )}
            {report.targetKind === 'peko' && report.targetId && (
              <button
                type="button"
                disabled={busy}
                className="btn-danger btn-sm"
                onClick={() =>
                  void run(`Take ${report.target} off PekoHub?`, () =>
                    api.takeDownPeko(report.targetId!, true, action),
                  )
                }
              >
                Take off PekoHub
              </button>
            )}
            {report.account && !report.account.suspended && (
              <button
                type="button"
                disabled={busy}
                className="btn-danger btn-sm"
                onClick={() =>
                  void run(
                    `Suspend @${report.account!.handle}? They're signed out everywhere and their runtimes disconnect.`,
                    () => api.suspendAccount(report.account!.id, true, action),
                  )
                }
              >
                Suspend @{report.account.handle}
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              className="btn-ghost btn-sm"
              onClick={() => void run(null, () => api.resolveReport(report.id, 'dismissed', action.reason))}
            >
              Dismiss
            </button>
          </div>
        </div>
      ) : (
        <Restore report={report} busy={busy} run={run} />
      )}
    </article>
  );
}

/** Undo what was done about a closed report: show the seed, let the peko back, lift the suspension. */
function Restore({
  report,
  busy,
  run,
}: {
  report: ModerationReport;
  busy: boolean;
  run: (confirmText: string | null, act: () => Promise<unknown>) => Promise<void>;
}) {
  const ref = parseHubRef(report.target);
  const seed = ref?.kind === 'seed' ? ref : null;
  const restoreTarget = report.targetRemoved && (seed || (report.targetKind === 'peko' && report.targetId));
  if (!restoreTarget && !report.account?.suspended) return null;

  return (
    <div className="mt-4 flex flex-wrap gap-2 border-t border-ink-700 pt-4">
      {restoreTarget && (
        <button
          type="button"
          disabled={busy}
          className="btn-secondary btn-sm"
          onClick={() =>
            void run(`Restore ${report.target}?`, async () => {
              if (seed) {
                await api.hideSeed(seed.owner, seed.name, false);
                if (seed.version) await api.yankSeedVersion(seed.owner, seed.name, seed.version, false);
              } else {
                await api.takeDownPeko(report.targetId!, false);
              }
            })
          }
        >
          Restore {report.target}
        </button>
      )}
      {report.account?.suspended && (
        <button
          type="button"
          disabled={busy}
          className="btn-secondary btn-sm"
          onClick={() =>
            void run(`Lift @${report.account!.handle}'s suspension?`, () =>
              api.suspendAccount(report.account!.id, false),
            )
          }
        >
          Lift suspension
        </button>
      )}
    </div>
  );
}
