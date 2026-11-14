import { createFileRoute, Link } from '@tanstack/react-router';
import { useCallback, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Laptop, X } from 'lucide-react';
import { useAuth } from '~/hooks/useAuth';
import { api } from '~/lib/api';
import { AppShell } from '~/components/AppShell';
import { Avatar, CopyField, EmptyState, ErrorNote, Loading, SectionTitle, Spinner, Unavailable } from '~/components/ui';
import { PageHeader } from '~/components/PageShell';
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
  head: () => ({ meta: [{ title: 'Account — PekoHub' }] }),
  component: ProfilePage,
});

function ProfilePage() {
  const { user } = useAuth();

  return (
    <AppShell>
      <PageHeader title="Account" />

      <div className="mt-8 space-y-14">
        <section className="flex items-center gap-4">
          <Avatar name={user?.displayName ?? ''} src={user?.avatarUrl} size="lg" />
          <div className="min-w-0">
            <p className="truncate text-base font-medium text-slate-100">{user?.displayName}</p>
            <p className="mt-0.5 truncate text-sm text-slate-500">
              @{user?.namespace}
              {user && !user.handleLocked && (
                <>
                  {' '}
                  <Link to="/welcome" search={{ next: '/profile' }} className="link text-xs">
                    Change
                  </Link>
                </>
              )}
              {user?.email && <> · {user.email}</>}
              {user?.createdAt && <> · joined {formatDate(user.createdAt)}</>}
            </p>
          </div>
        </section>
        <SignedInAppsPanel />
        <ApiKeysPanel />
      </div>
    </AppShell>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   Runtimes
   ───────────────────────────────────────────────────────────────────────── */

/** Peko desktop and the CLI, signed in as you; sign one out everywhere. */
function SignedInAppsPanel() {
  const queryClient = useQueryClient();
  const apps = useQuery({ queryKey: ['signed-in-apps'], queryFn: () => api.listSignedInApps() });
  const signOut = useMutation({
    mutationFn: (clientId: string) => api.signOutApp(clientId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['signed-in-apps'] }),
  });
  const rows = apps.data?.apps ?? [];

  return (
    <section>
      <SectionTitle title="Signed-in apps" />
      {apps.isLoading ? (
        <Loading />
      ) : apps.isError ? (
        <Unavailable />
      ) : rows.length === 0 ? (
        <EmptyState icon={<Laptop className="h-5 w-5" />} title="No apps signed in" />
      ) : (
        <ul className="rows">
          {rows.map((app) => (
            <li key={app.clientId} className="flex flex-wrap items-center gap-4 px-5 py-4" data-testid="signed-in-app">
              <Laptop className="h-4 w-4 text-slate-500" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-slate-100">{app.name}</p>
                <p className="mt-0.5 truncate text-xs text-slate-500">
                  {app.devices[0] ? `${app.devices[0]} · ` : ''}active {relativeTime(app.lastActiveAt)}
                </p>
              </div>
              <button
                type="button"
                disabled={signOut.isPending}
                onClick={() => {
                  if (window.confirm(`Sign ${app.name} out everywhere?`)) signOut.mutate(app.clientId);
                }}
                className="btn-danger btn-sm"
              >
                Sign out
              </button>
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
      <SectionTitle title="API keys" />

      {error && (
        <div className="mb-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      {revealed && (
        <div className="mb-4 rounded-xl border border-ink-500 bg-white/[0.03] p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="text-sm text-slate-100">Copy this key now. It won&apos;t be shown again.</p>
            <button onClick={() => setRevealed(null)} className="btn-icon p-1" aria-label="Dismiss">
              <X className="h-4 w-4" />
            </button>
          </div>
          <CopyField value={revealed} />
        </div>
      )}

      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void handleCreate();
        }}
      >
        <input
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          placeholder="Key name"
          aria-label="New key name"
          className="input max-w-xs"
        />
        <button type="submit" disabled={creating || !newName.trim()} className="btn-secondary flex-shrink-0">
          {creating && <Spinner className="h-4 w-4" />}
          Create key
        </button>
      </form>

      {loading ? (
        <Loading />
      ) : keys.length > 0 ? (
        <ul className="rows mt-4">
          {keys.map((key) => (
            <li key={key.id} className="flex flex-wrap items-center gap-4 px-5 py-4">
              <KeyRound className="h-4 w-4 text-slate-500" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-100">{key.name}</p>
                <p className="mt-0.5 truncate text-xs text-slate-500">
                  <span className="font-mono">{key.prefix}…</span> ·{' '}
                  {key.lastUsedAt ? `used ${relativeTime(key.lastUsedAt)}` : 'never used'}
                </p>
              </div>
              <button
                onClick={() => void handleRevoke(key.id)}
                disabled={revoking === key.id}
                className="btn-danger btn-sm"
              >
                {revoking === key.id && <Spinner className="h-3.5 w-3.5" />}
                Revoke
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
