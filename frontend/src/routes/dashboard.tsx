import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleDot, EyeOff, Globe, Lock, RefreshCw, X } from 'lucide-react';
import { useAuth } from '~/hooks/useAuth';
import { api, type OwnedInstanceRecord, type PekoTransfer } from '~/lib/api';
import { AppShell } from '~/components/AppShell';
import { PageHeader } from '~/components/PageShell';
import { Badge, CopyButton, EmptyState, ErrorNote, Loading, Spinner, StatusDot, type BadgeTone } from '~/components/ui';

/**
 * Owner dashboard.
 *
 * Lists every instance the signed-in user owns across all exposure
 * levels and lets them change exposure, status and the public profile.
 *
 * Two contracts worth knowing before touching this page:
 *  - `exposure = public` is the only arm that persists a
 *    `public_profile` server-side, so switching to public without a
 *    name/description would leave an unlistable instance. The publish
 *    form exists for exactly that reason.
 *  - ADR-056 D7 caps public/unlisted exposure at one instance per
 *    principal DID. A conflicting switch comes back as 409 and is
 *    surfaced inline rather than swallowed.
 */

type Exposure = OwnedInstanceRecord['exposure'];
type Status = OwnedInstanceRecord['status'];

const EXPOSURE_ORDER: Exposure[] = ['public', 'private', 'local_only'];

const EXPOSURE_META: Record<
  Exposure,
  { label: string; blurb: string; icon: typeof Globe; tone: BadgeTone }
> = {
  public: {
    label: 'Public',
    blurb: 'Anyone with its ID can message it',
    icon: Globe,
    tone: 'accent',
  },
  private: {
    label: 'Private',
    blurb: 'Only those you allow',
    icon: Lock,
    tone: 'neutral',
  },
  local_only: {
    label: 'Local only',
    blurb: 'Not reachable through PekoHub',
    icon: EyeOff,
    tone: 'neutral',
  },
};

const STATUSES: Status[] = ['online', 'offline', 'busy', 'error'];

const CATEGORIES = [
  'productivity',
  'coding',
  'creative',
  'business',
  'entertainment',
  'education',
  'other',
] as const;

export const Route = createFileRoute('/dashboard')({
  head: () => ({ meta: [{ title: 'Your pekos — PekoHub' }] }),
  component: DashboardPage,
});

function DashboardPage() {
  const { user } = useAuth();
  const [editing, setEditing] = useState<OwnedInstanceRecord | null>(null);

  const owned = useQuery({
    queryKey: ['dashboard', 'owned-instances'],
    queryFn: () => api.listOwnedInstances({ page: 1, perPage: 50 }),
    enabled: Boolean(user),
  });

  const instances = owned.data?.data ?? [];

  return (
    <AppShell>
      <PageHeader
        title="Your pekos"
        action={
          <button
            onClick={() => void owned.refetch()}
            disabled={owned.isFetching}
            className="btn-icon"
            aria-label="Refresh"
            title="Refresh"
          >
            {owned.isFetching ? <Spinner className="h-4 w-4" /> : <RefreshCw className="h-4 w-4" />}
          </button>
        }
      />

      <TransfersSection />

      <section className="mt-8">
        {owned.isLoading ? (
          <Loading />
        ) : owned.isError ? (
          <ErrorNote>
            Could not load your pekos —{' '}
            {owned.error instanceof Error ? owned.error.message : 'unknown error'}
          </ErrorNote>
        ) : instances.length === 0 ? (
          <EmptyState
            icon={<CircleDot className="h-5 w-5" />}
            title="No pekos online yet"
            body="Sign in from Peko desktop and put a peko online."
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {instances.map((instance) => (
              <InstanceCard
                key={instance.id}
                instance={instance}
                ownerHandle={user?.namespace ?? null}
                onManage={() => setEditing(instance)}
              />
            ))}
          </div>
        )}
      </section>

      {editing && (
        <ManageInstanceModal
          instance={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void owned.refetch();
          }}
        />
      )}
    </AppShell>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   Transfers (ADR-081 D4): a peko changes owner only when the new owner accepts
   ───────────────────────────────────────────────────────────────────────── */

function TransfersSection() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const transfers = useQuery({
    queryKey: ['dashboard', 'transfers'],
    queryFn: () => api.listTransfers(),
    enabled: Boolean(user),
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rows = transfers.data?.transfers ?? [];
  if (rows.length === 0) return null;

  const act = async (transfer: PekoTransfer, action: () => Promise<void>) => {
    setBusy(transfer.hubId);
    setError(null);
    try {
      await action();
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That didn’t go through');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="mt-8 space-y-2" aria-label="Transfers">
      {rows.map((transfer) => (
        <div
          key={transfer.hubId}
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-ink-700 px-4 py-3"
        >
          <p className="text-sm text-slate-300">
            {transfer.direction === 'incoming'
              ? `@${transfer.otherHandle ?? 'someone'} offers you ${transfer.pekoName}. Accepting makes you its owner; it keeps running on their computer.`
              : `${transfer.pekoName} is offered to @${transfer.otherHandle ?? 'someone'}. You own it until they accept.`}
          </p>
          <div className="flex items-center gap-2">
            {busy === transfer.hubId && <Spinner className="h-3.5 w-3.5" />}
            {transfer.direction === 'incoming' ? (
              <>
                <button
                  className="btn-ghost btn-sm"
                  disabled={busy !== null}
                  onClick={() => void act(transfer, () => api.withdrawTransfer(transfer.hubId))}
                >
                  Decline
                </button>
                <button
                  className="btn-primary btn-sm"
                  disabled={busy !== null}
                  onClick={() => void act(transfer, () => api.acceptTransfer(transfer.hubId))}
                >
                  Accept
                </button>
              </>
            ) : (
              <button
                className="btn-ghost btn-sm"
                disabled={busy !== null}
                onClick={() => void act(transfer, () => api.withdrawTransfer(transfer.hubId))}
              >
                Withdraw
              </button>
            )}
          </div>
        </div>
      ))}
      {error && <p className="text-xs text-rose-300">{error}</p>}
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   Card
   ───────────────────────────────────────────────────────────────────────── */

function InstanceCard({
  instance,
  ownerHandle,
  onManage,
}: {
  instance: OwnedInstanceRecord;
  ownerHandle: string | null;
  onManage: () => void;
}) {
  const meta = EXPOSURE_META[instance.exposure];
  // The peko's ID is its page (hub ADR-009); only a public one has one.
  const shareUrl = ownerHandle ? `${window.location.origin}/@${ownerHandle}/${instance.name}` : null;
  const live = instance.exposure === 'public';

  return (
    <article className="card flex flex-col p-5">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-[15px] font-medium text-slate-100">
            {instance.publicName ?? instance.name}
          </h3>
          <p className="mt-0.5 truncate text-xs text-slate-500">
            {ownerHandle ? `@${ownerHandle}/${instance.name}` : instance.name}
          </p>
        </div>
        <Badge tone={meta.tone}>{meta.label}</Badge>
      </header>

      {instance.description && (
        <p className="mt-3 line-clamp-2 text-[13px] leading-relaxed text-slate-400">{instance.description}</p>
      )}

      <p className="mt-4 flex items-center gap-2 text-xs text-slate-500">
        <StatusDot status={instance.status} />
        <span>{instance.status}</span>
        <span aria-hidden>·</span>
        <span className="truncate" title={instance.principalDid ?? undefined}>
          {instance.runtimeDisplayName ?? instance.runtimeId}
        </span>
      </p>

      <div className="mt-auto flex items-center justify-between gap-2 pt-5">
        <div className="-ml-2.5 flex items-center">
          {live && shareUrl && (
            <>
              <Link
                to="/@{$owner}/$name"
                params={{ owner: ownerHandle ?? '', name: instance.name }}
                className="btn-ghost btn-sm"
              >
                Open
              </Link>
              <CopyButton value={shareUrl} label="Link" className="btn-ghost btn-sm" />
            </>
          )}
        </div>
        <button onClick={onManage} className="btn-secondary btn-sm">
          Manage
        </button>
      </div>
    </article>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   Manage modal
   ───────────────────────────────────────────────────────────────────────── */

function ManageInstanceModal({
  instance,
  onClose,
  onSaved,
}: {
  instance: OwnedInstanceRecord;
  onClose: () => void;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'exposure' | 'status' | 'owner'>('exposure');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [exposure, setExposure] = useState<Exposure>(instance.exposure);
  const [status, setStatus] = useState<Status>(instance.status);

  // Public profile — only persisted by the backend on the `public` arm.
  const [publicName, setPublicName] = useState(instance.publicName ?? instance.name);
  const [description, setDescription] = useState(instance.description ?? '');
  const [category, setCategory] = useState(instance.category ?? 'other');
  const [tags, setTags] = useState(instance.tags.join(', '));

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const exposureChanged = exposure !== instance.exposure;
  const statusChanged = status !== instance.status;
  const publishing = exposure === 'public';
  const publishFormValid = !publishing || (publicName.trim() && description.trim());

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['dashboard'] });

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      if (exposureChanged) {
        await api.setInstanceExposure(
          instance.id,
          exposure,
          publishing
            ? {
                public_name: publicName.trim(),
                description: description.trim(),
                tags: tags
                  .split(',')
                  .map((tag) => tag.trim())
                  .filter(Boolean),
                category,
              }
            : undefined,
        );
      }
      if (statusChanged) {
        await api.setInstanceStatus(instance.id, status);
      }
      await invalidate();
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save changes');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm(`Revoke exposure and delete "${instance.name}"? This cannot be undone.`)) {
      return;
    }
    setDeleting(true);
    setError(null);
    try {
      await api.deleteInstance(instance.id);
      await invalidate();
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the peko');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-ink-950/80 p-4 backdrop-blur-sm sm:items-center"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="card animate-scale-in my-8 w-full max-w-lg bg-ink-900 shadow-lifted"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Manage ${instance.name}`}
      >
        <header className="flex items-center justify-between gap-4 px-6 pt-5">
          <h2 className="truncate text-lg font-semibold tracking-tight text-slate-50">
            {instance.publicName ?? instance.name}
          </h2>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-slate-500 transition-colors hover:bg-white/[0.06] hover:text-slate-200"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex items-center gap-6 border-b border-ink-700 px-6">
          <TabButton active={tab === 'exposure'} onClick={() => setTab('exposure')}>
            Exposure
          </TabButton>
          <TabButton active={tab === 'status'} onClick={() => setTab('status')}>
            Status
          </TabButton>
          {instance.hubId && (
            <TabButton active={tab === 'owner'} onClick={() => setTab('owner')}>
              Owner
            </TabButton>
          )}
        </div>

        <div className="max-h-[60vh] overflow-y-auto px-6 py-6">
          {error && (
            <div className="mb-5">
              <ErrorNote>{error}</ErrorNote>
            </div>
          )}

          {tab === 'exposure' ? (
            <div className="space-y-6">
              <div className="space-y-2">
                {EXPOSURE_ORDER.map((value) => {
                  const meta = EXPOSURE_META[value];
                  const Icon = meta.icon;
                  return (
                    <Choice key={value} selected={value === exposure} onClick={() => setExposure(value)}>
                      <Icon className="h-4 w-4 flex-shrink-0 text-slate-500" />
                      <span className="text-sm text-slate-100">{meta.label}</span>
                      <span className="ml-auto text-xs text-slate-500">{meta.blurb}</span>
                    </Choice>
                  );
                })}
              </div>

              {publishing && (
                <div className="space-y-4">
                  <ModalField label="Display name">
                    <input
                      value={publicName}
                      onChange={(event) => setPublicName(event.target.value)}
                      className="input"
                      placeholder="Ada"
                    />
                  </ModalField>

                  <ModalField label="Description">
                    <textarea
                      value={description}
                      onChange={(event) => setDescription(event.target.value)}
                      rows={3}
                      className="textarea"
                    />
                  </ModalField>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <ModalField label="Category">
                      <select
                        value={category}
                        onChange={(event) => setCategory(event.target.value)}
                        className="select capitalize"
                      >
                        {CATEGORIES.map((value) => (
                          <option key={value} value={value} className="capitalize">
                            {value}
                          </option>
                        ))}
                      </select>
                    </ModalField>
                    <ModalField label="Tags">
                      <input
                        value={tags}
                        onChange={(event) => setTags(event.target.value)}
                        className="input"
                        placeholder="research, rust"
                      />
                    </ModalField>
                  </div>
                </div>
              )}
            </div>
          ) : tab === 'owner' && instance.hubId ? (
            <TransferPanel
              hubId={instance.hubId}
              name={instance.publicName ?? instance.name}
              onTransferred={() => {
                void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
                onClose();
              }}
            />
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                {STATUSES.map((value) => (
                  <Choice key={value} selected={value === status} onClick={() => setStatus(value)}>
                    <StatusDot status={value} />
                    <span className="text-sm capitalize text-slate-100">{value}</span>
                  </Choice>
                ))}
              </div>
              <p className="text-xs text-slate-500">The runtime&apos;s heartbeat overrides this.</p>
            </div>
          )}
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-ink-700 px-6 py-4">
          <button
            onClick={() => void handleDelete()}
            disabled={deleting || saving}
            className="btn-danger btn-sm -ml-2.5"
          >
            {deleting && <Spinner className="h-3.5 w-3.5" />}
            Delete
          </button>

          <div className="flex items-center gap-2">
            <button onClick={onClose} className="btn-ghost btn-sm">
              Cancel
            </button>
            <button
              onClick={() => void handleSave()}
              disabled={saving || deleting || !publishFormValid || (!exposureChanged && !statusChanged)}
              className="btn-primary btn-sm"
            >
              {saving && <Spinner className="h-3.5 w-3.5" />}
              Save
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button onClick={onClick} className={`tab ${active ? 'tab-active' : ''}`}>
      {children}
    </button>
  );
}

/** One selectable option in the manage dialog. */
function Choice({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`flex w-full items-center gap-3 rounded-lg border px-3.5 py-3 text-left transition-colors ${
        selected ? 'border-slate-300 bg-white/[0.04]' : 'border-ink-700 hover:border-ink-600 hover:bg-ink-850'
      }`}
    >
      {children}
    </button>
  );
}

/** Offer the peko to another PekoHub account (ADR-081 D4). */
function TransferPanel({
  hubId,
  name,
  onTransferred,
}: {
  hubId: string;
  name: string;
  onTransferred: () => void;
}) {
  const [handle, setHandle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = handle.trim().replace(/^@/, '');

  const transfer = async () => {
    if (!window.confirm(`Offer ${name} to @${target}? They become its owner when they accept, and you can't undo that yourself.`)) return;
    setBusy(true);
    setError(null);
    try {
      await api.transferPeko(hubId, target);
      onTransferred();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The offer didn’t go through');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-400">
        Offer {name} to another PekoHub account. It moves when they accept, and keeps running on the same computer.
      </p>
      <ModalField label="New owner's handle">
        <input
          value={handle}
          onChange={(event) => setHandle(event.target.value)}
          placeholder="@handle"
          className="input"
          autoCapitalize="off"
          spellCheck={false}
        />
      </ModalField>
      {error && <p className="text-xs text-rose-300">{error}</p>}
      <button type="button" disabled={busy || !target} onClick={() => void transfer()} className="btn-secondary btn-sm">
        {busy && <Spinner className="h-3.5 w-3.5" />}
        Offer {name}
      </button>
    </div>
  );
}

function ModalField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="field-label mb-1.5 block">{label}</span>
      {children}
    </label>
  );
}
