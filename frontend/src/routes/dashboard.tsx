import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowUpRight,
  CircleDot,
  EyeOff,
  Globe,
  LinkIcon,
  Lock,
  PowerOff,
  RefreshCw,
  Settings2,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useAuth } from '~/hooks/useAuth';
import { api, type OwnedInstanceRecord } from '~/lib/api';
import { AppShell } from '~/components/AppShell';
import { Badge, CopyButton, EmptyState, ErrorNote, Spinner, Stat } from '~/components/ui';
import { relativeTime } from '~/lib/format';

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

const EXPOSURE_ORDER: Exposure[] = ['public', 'unlisted', 'private', 'unexposed'];

const EXPOSURE_META: Record<
  Exposure,
  { label: string; blurb: string; icon: typeof Globe; tone: 'peko' | 'iris' | 'neutral' | 'danger' }
> = {
  public: {
    label: 'Public',
    blurb: 'Listed in the directory. Anyone can find and chat with it.',
    icon: Globe,
    tone: 'peko',
  },
  unlisted: {
    label: 'Unlisted',
    blurb: 'Chat-able by anyone with the link, never indexed.',
    icon: LinkIcon,
    tone: 'iris',
  },
  private: {
    label: 'Private',
    blurb: 'Only subjects listed in the runtime’s permissions may chat.',
    icon: Lock,
    tone: 'neutral',
  },
  unexposed: {
    label: 'Unexposed',
    blurb: 'Not reachable through the hub at all.',
    icon: EyeOff,
    tone: 'danger',
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

  const counts = useMemo(
    () => ({
      total: instances.length,
      public: instances.filter((i) => i.exposure === 'public').length,
      online: instances.filter((i) => i.status === 'online').length,
    }),
    [instances],
  );

  return (
    <AppShell>
      <header className="flex flex-wrap items-end justify-between gap-5">
        <div className="min-w-0">
          <p className="eyebrow mb-2.5">owner console</p>
          <h1 className="display text-2xl sm:text-[28px]">Your pekos</h1>
          <p className="lede mt-2 max-w-2xl">
            Pekos announced by runtimes you own. Exposure and status changes are pushed down the
            tunnel — the runtime remains the authority on its own permissions.
          </p>
        </div>
        <button
          onClick={() => void owned.refetch()}
          disabled={owned.isFetching}
          className="btn-secondary btn-sm"
        >
          {owned.isFetching ? <Spinner className="h-3.5 w-3.5" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Refresh
        </button>
      </header>

      {instances.length > 0 && (
        <section className="mt-8 grid grid-cols-3 gap-3">
          <Stat label="total" value={counts.total} />
          <Stat label="public" value={counts.public} hint="indexed in the directory" />
          <Stat label="online" value={counts.online} hint="heartbeat within 90s" />
        </section>
      )}

      <section className="mt-8">
        {owned.isLoading ? (
          <div className="flex items-center justify-center gap-2.5 py-24 text-sm text-slate-500">
            <Spinner className="h-4 w-4" />
            Loading your pekos…
          </div>
        ) : owned.isError ? (
          <ErrorNote>
            Could not load your pekos —{' '}
            {owned.error instanceof Error ? owned.error.message : 'unknown error'}
          </ErrorNote>
        ) : instances.length === 0 ? (
          <EmptyState
            icon={<CircleDot className="h-5 w-5" />}
            title="No pekos announced yet"
            body={
              <>
                Start a runtime, create a peko, then set its exposure. It appears here as soon as the
                runtime announces itself over the tunnel.
              </>
            }
            action={
              <code className="code-block text-xs">
                {'exposure = "public"  # in the peko’s principal.toml'}
              </code>
            }
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
  const ExposureIcon = meta.icon;
  const shareUrl = ownerHandle
    ? `${window.location.origin}/peko/${ownerHandle}/${instance.name}`
    : null;
  const live = instance.exposure === 'public' || instance.exposure === 'unlisted';

  return (
    <article className="card card-hover flex flex-col p-5">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-[15px] font-semibold tracking-tight text-slate-100">
            {instance.publicName ?? instance.name}
          </h3>
          <p className="mt-1 truncate font-mono text-2xs text-slate-500">@{instance.name}</p>
        </div>
        <Badge tone={meta.tone}>
          <ExposureIcon className="h-2.5 w-2.5" />
          {meta.label}
        </Badge>
      </header>

      <p className="mt-3 line-clamp-2 min-h-[2.4rem] text-[13px] leading-relaxed text-slate-400">
        {instance.description ?? 'No public description yet.'}
      </p>

      <dl className="mt-4 space-y-1.5 font-mono text-2xs text-slate-600">
        <div className="flex items-center justify-between gap-3">
          <dt>runtime</dt>
          <dd className="truncate text-slate-500">
            {instance.runtimeDisplayName ?? instance.runtimeId}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt>status</dt>
          <dd className="flex items-center gap-1.5 text-slate-500">
            <StatusGlyph status={instance.status} />
            {instance.status}
            {instance.lastSeenAt && (
              <span className="text-slate-700">· {relativeTime(instance.lastSeenAt)}</span>
            )}
          </dd>
        </div>
        {instance.principalDid && (
          <div className="flex items-center justify-between gap-3">
            <dt>did</dt>
            <dd className="truncate text-slate-500" title={instance.principalDid}>
              {instance.principalDid}
            </dd>
          </div>
        )}
      </dl>

      <div className="mt-auto flex items-center justify-between gap-2 border-t border-white/[0.06] pt-4">
        <div className="flex items-center gap-1.5">
          {live && shareUrl && (
            <>
              <CopyButton value={shareUrl} label="Link" className="btn-ghost btn-sm" />
              <Link
                to="/peko/$owner/$pekoName"
                params={{ owner: ownerHandle ?? '', pekoName: instance.name }}
                className="btn-ghost btn-sm"
              >
                Open
                <ArrowUpRight className="h-3 w-3" />
              </Link>
            </>
          )}
        </div>
        <button onClick={onManage} className="btn-secondary btn-sm">
          <Settings2 className="h-3.5 w-3.5" />
          Manage
        </button>
      </div>
    </article>
  );
}

function StatusGlyph({ status }: { status: Status }) {
  const map: Record<Status, { cls: string; Icon: typeof CircleDot }> = {
    online: { cls: 'text-emerald-400', Icon: CircleDot },
    busy: { cls: 'text-amber-400', Icon: CircleDot },
    error: { cls: 'text-rose-400', Icon: TriangleAlert },
    offline: { cls: 'text-slate-600', Icon: PowerOff },
  };
  const { cls, Icon } = map[status];
  return <Icon className={`h-3 w-3 ${cls}`} />;
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
  const [tab, setTab] = useState<'exposure' | 'status'>('exposure');
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
  const [tosRequired, setTosRequired] = useState(instance.tosRequired);
  const [tosText, setTosText] = useState(instance.tosText ?? '');
  const [dailyQuota, setDailyQuota] = useState(instance.dailyQuota?.toString() ?? '');
  const [weeklyQuota, setWeeklyQuota] = useState(instance.weeklyQuota?.toString() ?? '');

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
                tos_required: tosRequired,
                tos_text: tosRequired ? tosText : undefined,
                daily_quota: dailyQuota ? Number(dailyQuota) : undefined,
                weekly_quota: weeklyQuota ? Number(weeklyQuota) : undefined,
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
      className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-ink-950/80 p-4 backdrop-blur-md sm:items-center"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="panel animate-scale-in my-8 w-full max-w-xl"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Manage ${instance.name}`}
      >
        <header className="flex items-start justify-between gap-4 border-b border-white/[0.06] px-6 py-5">
          <div className="min-w-0">
            <p className="font-mono text-2xs text-slate-500">@{instance.name}</p>
            <h2 className="display mt-1 truncate text-lg">
              {instance.publicName ?? instance.name}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-slate-500 transition-colors hover:bg-white/[0.06] hover:text-slate-200"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex items-center gap-1 border-b border-white/[0.06] px-4">
          <button
            onClick={() => setTab('exposure')}
            className={`tab ${tab === 'exposure' ? 'tab-active' : ''}`}
          >
            <Globe className="h-3.5 w-3.5" />
            Exposure
          </button>
          <button
            onClick={() => setTab('status')}
            className={`tab ${tab === 'status' ? 'tab-active' : ''}`}
          >
            <CircleDot className="h-3.5 w-3.5" />
            Status
          </button>
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
                  const selected = value === exposure;
                  return (
                    <button
                      key={value}
                      onClick={() => setExposure(value)}
                      aria-pressed={selected}
                      className={`flex w-full items-start gap-3 rounded-lg border px-3.5 py-3 text-left transition-all ${
                        selected
                          ? 'border-peko-400/50 bg-peko-400/[0.07]'
                          : 'border-white/[0.07] bg-white/[0.015] hover:border-ink-500 hover:bg-white/[0.035]'
                      }`}
                    >
                      <span
                        className={`mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md border ${
                          selected
                            ? 'border-peko-400/40 bg-peko-400/15 text-peko-200'
                            : 'border-white/[0.08] bg-white/[0.03] text-slate-500'
                        }`}
                      >
                        <Icon className="h-3.5 w-3.5" />
                      </span>
                      <span className="min-w-0">
                        <span
                          className={`block text-sm font-medium ${
                            selected ? 'text-peko-100' : 'text-slate-200'
                          }`}
                        >
                          {meta.label}
                        </span>
                        <span className="mt-0.5 block text-2xs leading-relaxed text-slate-500">
                          {meta.blurb}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>

              {publishing && (
                <div className="space-y-4 rounded-lg border border-white/[0.07] bg-white/[0.015] p-4">
                  <p className="eyebrow">public profile</p>
                  <p className="text-2xs leading-relaxed text-slate-500">
                    Required to be listed. The hub only stores what it needs to render the directory
                    card — never your peko&apos;s memory or keys.
                  </p>

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
                      placeholder="What does this peko do, and what is it good at?"
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
                    <ModalField label="Tags" hint="comma separated">
                      <input
                        value={tags}
                        onChange={(event) => setTags(event.target.value)}
                        className="input"
                        placeholder="research, rust"
                      />
                    </ModalField>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <ModalField label="Daily quota" hint="blank = unlimited">
                      <input
                        value={dailyQuota}
                        onChange={(event) => setDailyQuota(event.target.value.replace(/\D/g, ''))}
                        inputMode="numeric"
                        className="input"
                        placeholder="200"
                      />
                    </ModalField>
                    <ModalField label="Weekly quota" hint="blank = unlimited">
                      <input
                        value={weeklyQuota}
                        onChange={(event) => setWeeklyQuota(event.target.value.replace(/\D/g, ''))}
                        inputMode="numeric"
                        className="input"
                        placeholder="1000"
                      />
                    </ModalField>
                  </div>

                  <label className="flex items-start gap-3 rounded-lg border border-white/[0.07] bg-ink-900/60 px-3.5 py-3">
                    <input
                      type="checkbox"
                      checked={tosRequired}
                      onChange={(event) => setTosRequired(event.target.checked)}
                      className="mt-0.5 h-4 w-4 rounded border-ink-500 bg-ink-900 text-peko-500 focus:ring-peko-400/40"
                    />
                    <span>
                      <span className="block text-sm text-slate-200">
                        Require terms of service
                      </span>
                      <span className="mt-0.5 block text-2xs text-slate-500">
                        Visitors must acknowledge before their first message.
                      </span>
                    </span>
                  </label>

                  {tosRequired && (
                    <ModalField label="Terms text">
                      <textarea
                        value={tosText}
                        onChange={(event) => setTosText(event.target.value)}
                        rows={4}
                        className="textarea"
                        placeholder="Be kind. Don't paste secrets."
                      />
                    </ModalField>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-2">
                {STATUSES.map((value) => (
                  <button
                    key={value}
                    onClick={() => setStatus(value)}
                    aria-pressed={value === status}
                    className={`flex items-center gap-2.5 rounded-lg border px-3.5 py-3 text-left transition-all ${
                      value === status
                        ? 'border-peko-400/50 bg-peko-400/[0.07] text-peko-100'
                        : 'border-white/[0.07] bg-white/[0.015] text-slate-300 hover:border-ink-500 hover:bg-white/[0.035]'
                    }`}
                  >
                    <StatusGlyph status={value} />
                    <span className="text-sm font-medium capitalize">{value}</span>
                  </button>
                ))}
              </div>
              <p className="text-2xs leading-relaxed text-slate-500">
                Status is a hub-side mirror used for discovery badges. The runtime drives it through
                its heartbeat — manual changes are reverted on the next beat.
              </p>
            </div>
          )}
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.06] px-6 py-4">
          <button
            onClick={() => void handleDelete()}
            disabled={deleting || saving}
            className="btn-danger btn-sm"
          >
            {deleting ? <Spinner className="h-3.5 w-3.5" /> : <Trash2 className="h-3.5 w-3.5" />}
            Delete peko
          </button>

          <div className="flex items-center gap-2">
            <button onClick={onClose} className="btn-secondary btn-sm">
              Cancel
            </button>
            <button
              onClick={() => void handleSave()}
              disabled={saving || deleting || !publishFormValid || (!exposureChanged && !statusChanged)}
              className="btn-primary btn-sm"
            >
              {saving && <Spinner className="h-3.5 w-3.5" />}
              {exposureChanged || statusChanged ? 'Save changes' : 'No changes'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function ModalField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-baseline gap-2">
        <span className="eyebrow">{label}</span>
        {hint && <span className="font-mono text-2xs text-slate-600">{hint}</span>}
      </span>
      {children}
    </label>
  );
}
