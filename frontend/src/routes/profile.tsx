import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  CalendarDays,
  Copy,
  Cpu,
  KeyRound,
  Mail,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { useAuth } from '~/hooks/useAuth';
import { api } from '~/lib/api';
import { AppShell } from '~/components/AppShell';
import { Avatar, Badge, EmptyState, ErrorNote, Spinner, StatusDot } from '~/components/ui';
import { formatDate, relativeTime } from '~/lib/format';

/**
 * Account page.
 *
 * Three things an owner needs and nothing else:
 *  - who they are (identity + handle);
 *  - which runtimes are registered to them (where their pekos live);
 *  - API keys for the CLI.
 *
 * The pre-pivot "my bundles" section is gone: bundles/packages were a
 * pre-ADR-056 concept and registry browsing now lives under
 * `/seeds`, filtered to the seed lane.
 */
export const Route = createFileRoute('/profile')({
  component: ProfilePage,
});

function ProfilePage() {
  const { user } = useAuth();

  return (
    <AppShell>
      <div className="mb-8">
        <p className="eyebrow mb-2.5">account</p>
        <h1 className="display text-2xl sm:text-[28px]">Profile</h1>
        <p className="lede mt-2 max-w-2xl">
          Your hub identity, the runtimes registered to it, and the keys your CLI uses to push
          seeds and announce pekos.
        </p>
      </div>

      <div className="space-y-10">
        <IdentityPanel
          displayName={user?.displayName ?? ''}
          namespace={user?.namespace ?? ''}
          email={user?.email}
          avatarUrl={user?.avatarUrl}
          createdAt={user?.createdAt}
        />
        <RuntimesPanel />
        <ApiKeysPanel />
      </div>
    </AppShell>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   Identity
   ───────────────────────────────────────────────────────────────────────── */

function IdentityPanel({
  displayName,
  namespace,
  email,
  avatarUrl,
  createdAt,
}: {
  displayName: string;
  namespace: string;
  email?: string;
  avatarUrl?: string | null;
  createdAt?: string;
}) {
  return (
    <section className="panel p-6">
      <div className="flex flex-wrap items-center gap-5">
        <Avatar name={displayName} src={avatarUrl} size="xl" />
        <div className="min-w-0">
          <h2 className="display text-xl">{displayName}</h2>
          <p className="mt-1 font-mono text-xs text-slate-500">@{namespace}</p>
          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
            {email && (
              <span className="flex items-center gap-1.5 text-xs text-slate-400">
                <Mail className="h-3.5 w-3.5 text-slate-600" />
                {email}
              </span>
            )}
            {createdAt && (
              <span className="flex items-center gap-1.5 text-xs text-slate-400">
                <CalendarDays className="h-3.5 w-3.5 text-slate-600" />
                joined {formatDate(createdAt)}
              </span>
            )}
            <span className="flex items-center gap-1.5 text-xs text-emerald-300">
              <ShieldCheck className="h-3.5 w-3.5" />
              OAuth verified
            </span>
          </div>
        </div>
      </div>

      <div className="divider my-6" />

      <p className="text-2xs leading-relaxed text-slate-500">
        Your handle is what share links resolve against (
        <code className="code-inline">/peko/{namespace}/&lt;peko&gt;</code>). The hub stores your
        OAuth identity and nothing else about you — peko memory, sessions and keys never leave the
        runtime that hosts them.
      </p>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   Runtimes
   ───────────────────────────────────────────────────────────────────────── */

function RuntimesPanel() {
  const runtimes = useQuery({
    queryKey: ['runtimes'],
    queryFn: () => api.listRuntimes(),
  });

  const rows = runtimes.data?.runtimes ?? [];

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow mb-2">hosts</p>
          <h2 className="display text-xl">Registered runtimes</h2>
        </div>
        <button
          onClick={() => void runtimes.refetch()}
          disabled={runtimes.isFetching}
          className="btn-secondary btn-sm"
        >
          {runtimes.isFetching ? (
            <Spinner className="h-3.5 w-3.5" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          Refresh
        </button>
      </div>

      {runtimes.isLoading ? (
        <div className="flex items-center justify-center gap-2.5 py-12 text-sm text-slate-500">
          <Spinner className="h-4 w-4" />
          Loading runtimes…
        </div>
      ) : runtimes.isError ? (
        <ErrorNote>
          Could not load runtimes —{' '}
          {runtimes.error instanceof Error ? runtimes.error.message : 'unknown error'}
        </ErrorNote>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Cpu className="h-5 w-5" />}
          title="No runtimes registered"
          body={
            <>
              Run <code className="code-inline">peko tunnel setup</code> on the machine hosting your
              pekos. It registers the runtime DID here with a proof-of-possession signature.
            </>
          }
        />
      ) : (
        <ul className="divide-y divide-white/[0.06] overflow-hidden rounded-xl border border-white/[0.07] bg-ink-850/70">
          {rows.map((runtime) => (
            <li
              key={runtime.id}
              className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5"
            >
              <div className="flex min-w-0 items-center gap-3">
                <StatusDot status={runtime.lastSeenAt ? 'online' : 'offline'} />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-slate-200">
                    {runtime.displayName ?? 'Unnamed runtime'}
                  </p>
                  <p className="truncate font-mono text-2xs text-slate-600" title={runtime.runtimeDid}>
                    {runtime.runtimeDid}
                  </p>
                </div>
              </div>
              <p className="font-mono text-2xs text-slate-600">
                {runtime.lastSeenAt ? `seen ${relativeTime(runtime.lastSeenAt)}` : 'never seen'}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   API keys
   ───────────────────────────────────────────────────────────────────────── */

interface ApiKeyRow {
  id: number;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

function ApiKeysPanel() {
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.listApiKeys();
      setKeys(data.keys);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load keys');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    setError(null);
    try {
      const created = await api.generateApiKey(name);
      setRevealed(created.key);
      setNewName('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the key');
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (id: number) => {
    if (!window.confirm('Revoke this key? Anything using it stops working immediately.')) return;
    setRevoking(id);
    setError(null);
    try {
      await api.revokeApiKey(id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not revoke the key');
    } finally {
      setRevoking(null);
    }
  };

  return (
    <section>
      <div className="mb-4">
        <p className="eyebrow mb-2">credentials</p>
        <h2 className="display text-xl">API keys</h2>
        <p className="lede mt-1.5 max-w-2xl">
          Used by the CLI to push seeds and by CI to publish. Keys are shown once — the hub only
          keeps a hash.
        </p>
      </div>

      {error && (
        <div className="mb-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      {revealed && (
        <div className="mb-4 rounded-lg border border-emerald-400/25 bg-emerald-400/[0.06] p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="eyebrow text-emerald-300">copy it now</p>
              <p className="mt-1 text-[13px] text-emerald-200/80">
                This key will not be shown again.
              </p>
            </div>
            <button
              onClick={() => setRevealed(null)}
              className="font-mono text-2xs text-emerald-300/70 transition-colors hover:text-emerald-200"
            >
              dismiss
            </button>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <code className="code-block flex-1 break-all text-emerald-200">{revealed}</code>
            <button
              onClick={() => void navigator.clipboard?.writeText(revealed)}
              className="btn-secondary btn-sm flex-shrink-0"
              title="Copy key"
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void handleCreate();
          }}
          placeholder="Key name — e.g. “laptop” or “ci-publish”"
          aria-label="New key name"
          className="input flex-1"
        />
        <button
          onClick={() => void handleCreate()}
          disabled={creating || !newName.trim()}
          className="btn-primary flex-shrink-0"
        >
          {creating ? <Spinner className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
          Generate key
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2.5 py-12 text-sm text-slate-500">
          <Spinner className="h-4 w-4" />
          Loading keys…
        </div>
      ) : keys.length === 0 ? (
        <div className="mt-4">
          <EmptyState
            icon={<KeyRound className="h-5 w-5" />}
            title="No API keys yet"
            body="Generate one to authenticate the CLI without a browser round-trip."
          />
        </div>
      ) : (
        <ul className="mt-4 divide-y divide-white/[0.06] overflow-hidden rounded-xl border border-white/[0.07] bg-ink-850/70">
          {keys.map((key) => (
            <li
              key={key.id}
              className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5"
            >
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border border-white/[0.07] bg-white/[0.03]">
                  <KeyRound className="h-3.5 w-3.5 text-slate-500" />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-slate-200">{key.name}</p>
                  <p className="truncate font-mono text-2xs text-slate-600">
                    {key.prefix}••••••••
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-4">
                <div className="text-right font-mono text-2xs text-slate-600">
                  <p>created {formatDate(key.createdAt)}</p>
                  <p>
                    {key.lastUsedAt ? `last used ${relativeTime(key.lastUsedAt)}` : 'never used'}
                  </p>
                </div>
                <button
                  onClick={() => void handleRevoke(key.id)}
                  disabled={revoking === key.id}
                  className="btn-ghost btn-sm text-rose-300 hover:bg-rose-500/10 hover:text-rose-200"
                >
                  {revoking === key.id ? (
                    <Spinner className="h-3.5 w-3.5" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" />
                  )}
                  Revoke
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 flex items-center gap-2">
        <Badge tone="neutral">scope: registry write</Badge>
        <p className="font-mono text-2xs text-slate-600">
          send as <span className="text-slate-500">Authorization: Bearer pkr_…</span>
        </p>
      </div>
    </section>
  );
}
