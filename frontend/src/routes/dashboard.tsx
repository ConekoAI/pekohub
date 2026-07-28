import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Loader2,
  RefreshCw,
  ExternalLink,
  Trash2,
  Settings,
  Globe,
  EyeOff,
  Lock,
  LinkIcon,
  CircleDot,
  PowerOff,
  AlertTriangle,
  Users,
} from 'lucide-react';
import { useAuth } from '~/hooks/useAuth';
import { api, type OwnedInstanceRecord } from '~/lib/api';
import { AppShell } from '~/components/AppShell';
import { SignInModal } from '~/components/SignInModal';

/**
 * PR #7: Owner dashboard. Lists every instance the signed-in user
 * owns (across all exposure levels) and lets them flip exposure,
 * status, and copy a fresh public share link.
 *
 * The route is auth-gated by AppShell / useAuth — only renders
 * cards once the JWT user is resolved. The "Sign in" CTA is
 * shown when the JWT check completes and no user is present.
 */
export const Route = createFileRoute('/dashboard')({
  component: DashboardPage,
});

type Exposure = OwnedInstanceRecord['exposure'];
type Status = OwnedInstanceRecord['status'];

const EXPOSURE_ORDER: Exposure[] = ['public', 'unlisted', 'private', 'unexposed'];
const EXPOSURE_LABEL: Record<Exposure, string> = {
  public: 'Public',
  unlisted: 'Unlisted',
  private: 'Private',
  unexposed: 'Unexposed',
};
const EXPOSURE_COLOR: Record<Exposure, string> = {
  public: 'bg-emerald-100 text-emerald-700',
  unlisted: 'bg-amber-100 text-amber-700',
  private: 'bg-slate-100 text-slate-700',
  unexposed: 'bg-red-100 text-red-700',
};
const EXPOSURE_ICON: Record<Exposure, typeof Globe> = {
  public: Globe,
  unlisted: LinkIcon,
  private: Lock,
  unexposed: EyeOff,
};

const STATUS_COLOR: Record<Status, string> = {
  online: 'bg-emerald-500',
  offline: 'bg-gray-400',
  busy: 'bg-amber-500',
  error: 'bg-red-500',
};
const STATUS_ICON: Record<Status, typeof CircleDot> = {
  online: CircleDot,
  offline: PowerOff,
  busy: CircleDot,
  error: AlertTriangle,
};

function DashboardPage() {
  const { user, isLoading, isAuthenticated } = useAuth();
  const [signInOpen, setSignInOpen] = useState(false);
  const [editing, setEditing] = useState<OwnedInstanceRecord | null>(null);

  // List owned instances. `enabled` guards against the JWT-only path
  // — useAuth still calls `api.getMe` to determine auth state, so by
  // the time this renders either we have a user or we don't.
  const owned = useQuery({
    queryKey: ['dashboard', 'owned-instances'],
    queryFn: () => api.listOwnedInstances({ page: 1, perPage: 50 }),
    enabled: isAuthenticated,
  });

  if (isLoading) {
    return (
      <AppShell>
        <div className="flex min-h-[40vh] items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-peko-600" />
        </div>
      </AppShell>
    );
  }

  if (!isAuthenticated || !user) {
    return (
      <AppShell>
        <div className="rounded-lg border border-dashed border-gray-300 bg-white p-8 text-center">
          <Users className="mx-auto h-8 w-8 text-gray-400" />
          <h1 className="mt-3 text-xl font-semibold text-gray-900">Sign in required</h1>
          <p className="mt-2 text-gray-600">
            Sign in with your PekoHub account to manage your shared principals.
          </p>
          <button onClick={() => setSignInOpen(true)} className="btn-primary mt-4 inline-flex">
            Sign In
          </button>
        </div>
        <SignInModal isOpen={signInOpen} onClose={() => setSignInOpen(false)} />
      </AppShell>
    );
  }

  return (
    <AppShell>
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
          <p className="mt-1 text-sm text-gray-600">
            Manage principals shared from your connected runtimes.
          </p>
        </div>
        <button
          onClick={() => void owned.refetch()}
          className="btn-secondary inline-flex items-center gap-2 text-xs"
          disabled={owned.isFetching}
        >
          {owned.isFetching ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RefreshCw className="h-3 w-3" />
          )}
          Refresh
        </button>
      </header>

      {owned.isLoading ? (
        <div className="mt-12 text-center text-gray-500">
          <Loader2 className="mx-auto h-6 w-6 animate-spin" />
          <p className="mt-2">Loading your principals...</p>
        </div>
      ) : owned.error ? (
        <div className="mt-12 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          Failed to load: {owned.error instanceof Error ? owned.error.message : 'Unknown error'}
        </div>
      ) : !owned.data || owned.data.data.length === 0 ? (
        <div className="mt-12 rounded-lg border border-dashed border-gray-300 bg-white p-12 text-center">
          <h2 className="text-lg font-semibold text-gray-900">No principals yet</h2>
          <p className="mt-2 text-sm text-gray-600">
            Connect a PekoHub-aware runtime and expose one of its principals to see it here.
          </p>
          <p className="mt-4 text-xs text-gray-500">
            <code className="rounded bg-gray-100 px-2 py-1">peko principal expose &lt;name&gt; public</code>
          </p>
        </div>
      ) : (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {owned.data.data.map((inst) => (
            <InstanceCard key={inst.id} instance={inst} onEdit={() => setEditing(inst)} />
          ))}
        </div>
      )}

      {editing && (
        <EditInstanceModal
          instance={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void owned.refetch();
          }}
        />
      )}
      <SignInModal isOpen={signInOpen} onClose={() => setSignInOpen(false)} />
    </AppShell>
  );
}

function InstanceCard({
  instance,
  onEdit,
}: {
  instance: OwnedInstanceRecord;
  onEdit: () => void;
}) {
  const ExposureIcon = EXPOSURE_ICON[instance.exposure];
  const StatusIcon = STATUS_ICON[instance.status];
  const lastSeen = instance.lastSeenAt ? new Date(instance.lastSeenAt) : null;
  const shareUrl =
    instance.exposure !== 'unexposed'
      ? `${typeof window !== 'undefined' ? window.location.origin : ''}/p/${namespaceFor(instance)}/${instance.name}`
      : null;

  return (
    <div className="card p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate font-semibold text-gray-900">
            {instance.publicName ?? instance.name}
          </h3>
          <p className="mt-0.5 truncate text-xs text-gray-500">
            @{instance.name} · {instance.runtimeDisplayName ?? instance.runtimeId}
          </p>
        </div>
        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${EXPOSURE_COLOR[instance.exposure]}`}>
          <ExposureIcon className="h-3 w-3" />
          {EXPOSURE_LABEL[instance.exposure]}
        </span>
      </div>

      {instance.description && (
        <p className="mt-2 line-clamp-2 text-sm text-gray-600">{instance.description}</p>
      )}

      <div className="mt-3 flex items-center gap-2 text-xs text-gray-500">
        <span className={`inline-block h-2 w-2 rounded-full ${STATUS_COLOR[instance.status]}`} aria-hidden />
        <StatusIcon className="h-3 w-3" />
        <span className="capitalize">{instance.status}</span>
        {lastSeen && (
          <>
            <span>·</span>
            <span title={lastSeen.toISOString()}>last seen {relativeTime(lastSeen)}</span>
          </>
        )}
      </div>

      <div className="mt-4 flex items-center justify-between">
        <div className="flex items-center gap-1">
          {shareUrl && (
            <Link
              to="/p/$owner/$principalName"
              params={{ owner: namespaceFor(instance), principalName: instance.name }}
              target="_blank"
              className="text-xs text-peko-600 hover:underline inline-flex items-center gap-1"
            >
              <ExternalLink className="h-3 w-3" />
              Open
            </Link>
          )}
        </div>
        <button
          onClick={onEdit}
          className="btn-secondary inline-flex items-center gap-1 text-xs py-1"
        >
          <Settings className="h-3 w-3" />
          Edit
        </button>
      </div>
    </div>
  );
}

function EditInstanceModal({
  instance,
  onClose,
  onSaved,
}: {
  instance: OwnedInstanceRecord;
  onClose: () => void;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const [exposure, setExposure] = useState<Exposure>(instance.exposure);
  const [status, setStatus] = useState<Status>(instance.status);
  const [savingExposure, setSavingExposure] = useState(false);
  const [savingStatus, setSavingStatus] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleExposure = async () => {
    if (exposure === instance.exposure) return;
    setSavingExposure(true);
    setError(null);
    try {
      await api.setInstanceExposure(instance.id, exposure);
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update exposure');
    } finally {
      setSavingExposure(false);
    }
  };

  const handleStatus = async () => {
    if (status === instance.status) return;
    setSavingStatus(true);
    setError(null);
    try {
      await api.setInstanceStatus(instance.id, status);
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update status');
    } finally {
      setSavingStatus(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm(`Delete "${instance.name}"? This cannot be undone.`)) return;
    setDeleting(true);
    setError(null);
    try {
      await api.deleteInstance(instance.id);
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-lg bg-white p-6 shadow-xl">
        <h2 className="text-lg font-semibold text-gray-900">
          {instance.publicName ?? instance.name}
        </h2>
        <p className="mt-1 text-sm text-gray-500">@{instance.name}</p>

        {error && (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="mt-6 space-y-5">
          <Field label="Exposure">
            <div className="flex flex-wrap gap-2">
              {EXPOSURE_ORDER.map((e) => {
                const Icon = EXPOSURE_ICON[e];
                const selected = e === exposure;
                return (
                  <button
                    key={e}
                    onClick={() => setExposure(e)}
                    className={
                      selected
                        ? 'inline-flex items-center gap-1 rounded-full border border-peko-600 bg-peko-50 px-3 py-1 text-xs font-medium text-peko-700'
                        : 'inline-flex items-center gap-1 rounded-full border border-gray-200 bg-white px-3 py-1 text-xs text-gray-600 hover:border-gray-300'
                    }
                  >
                    <Icon className="h-3 w-3" />
                    {EXPOSURE_LABEL[e]}
                  </button>
                );
              })}
            </div>
            <button
              onClick={handleExposure}
              disabled={savingExposure || exposure === instance.exposure}
              className="btn-primary mt-3 text-xs py-1.5"
            >
              {savingExposure ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Apply exposure change'}
            </button>
          </Field>

          <Field label="Status">
            <div className="flex flex-wrap gap-2">
              {(['online', 'offline', 'busy', 'error'] as Status[]).map((s) => {
                const Icon = STATUS_ICON[s];
                const selected = s === status;
                return (
                  <button
                    key={s}
                    onClick={() => setStatus(s)}
                    className={
                      selected
                        ? 'inline-flex items-center gap-1 rounded-full border border-peko-600 bg-peko-50 px-3 py-1 text-xs font-medium text-peko-700 capitalize'
                        : 'inline-flex items-center gap-1 rounded-full border border-gray-200 bg-white px-3 py-1 text-xs text-gray-600 capitalize hover:border-gray-300'
                    }
                  >
                    <Icon className="h-3 w-3" />
                    {s}
                  </button>
                );
              })}
            </div>
            <button
              onClick={handleStatus}
              disabled={savingStatus || status === instance.status}
              className="btn-primary mt-3 text-xs py-1.5"
            >
              {savingStatus ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Apply status change'}
            </button>
          </Field>
        </div>

        <div className="mt-6 flex items-center justify-between border-t border-gray-100 pt-4">
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="inline-flex items-center gap-1 text-xs font-medium text-red-600 hover:text-red-700 disabled:opacity-50"
          >
            {deleting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
            Delete instance
          </button>
          <button onClick={onClose} className="btn-secondary text-xs py-1.5">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</div>
      <div className="mt-2">{children}</div>
    </div>
  );
}

function namespaceFor(instance: OwnedInstanceRecord): string {
  // No explicit owner namespace is stored in InstanceRecord — the
  // dashboard's signed-in user IS the owner, but the share-link
  // path requires `${owner}/${name}`. Best-effort: prefer the
  // owner's `id` (always present), fall back to a slug from the
  // runtime id. The share URL is purely cosmetic here; the real
  // resolving authority is `/v1/public/principals/:owner/:name`
  // which 404s gracefully on a miss.
  return (
    (instance.ownerSubject && instance.ownerSubject.id) ||
    instance.runtimeId.replace(/[^a-z0-9-]/gi, '-')
  );
}

function relativeTime(d: Date): string {
  const diff = Date.now() - d.getTime();
  const seconds = Math.round(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
