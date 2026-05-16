import { createFileRoute } from '@tanstack/react-router';
import { useAuth } from '~/hooks/useAuth';
import { useSearch } from '~/hooks/useSearch';
import { BundleCard } from '~/components/BundleCard';
import { User, Key, Loader2, Package } from 'lucide-react';
import { useState } from 'react';
import { api } from '~/lib/api';
import { useQueryClient } from '@tanstack/react-query';

export const Route = createFileRoute('/profile')({
  component: ProfilePage,
});

function ProfilePage() {
  const { user, isLoading, isAuthenticated } = useAuth();
  const queryClient = useQueryClient();
  const [apiKeys, setApiKeys] = useState<Array<{ id: number; name: string; prefix: string; createdAt: string }>>([]);
  const [keysLoading, setKeysLoading] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [generatedKey, setGeneratedKey] = useState<string | null>(null);

  const search = useSearch({
    q: user?.namespace ?? '',
    page: 1,
    perPage: 20,
  });

  const loadApiKeys = async () => {
    setKeysLoading(true);
    try {
      const data = await api.listApiKeys();
      setApiKeys(data.keys);
    } catch {
      // ignore
    } finally {
      setKeysLoading(false);
    }
  };

  const handleGenerateKey = async () => {
    if (!newKeyName.trim()) return;
    try {
      const data = await api.generateApiKey(newKeyName.trim());
      setGeneratedKey(data.key);
      setNewKeyName('');
      loadApiKeys();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to generate key');
    }
  };

  const handleRevokeKey = async (id: number) => {
    if (!confirm('Are you sure you want to revoke this API key?')) return;
    try {
      await api.revokeApiKey(id);
      loadApiKeys();
      queryClient.invalidateQueries();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to revoke key');
    }
  };

  if (isLoading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-peko-600" />
      </div>
    );
  }

  if (!isAuthenticated || !user) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-12 text-center">
        <User className="mx-auto h-12 w-12 text-gray-400" />
        <h1 className="mt-4 text-2xl font-bold text-gray-900">Sign in required</h1>
        <p className="mt-2 text-gray-600">Please sign in to view your profile.</p>
        <a
          href="/api/v1/auth/github/authorize"
          className="btn-primary mt-6 inline-flex"
        >
          Sign In
        </a>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      {/* Profile Header */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-4">
        {user.avatarUrl ? (
          <img
            src={user.avatarUrl}
            alt={user.displayName}
            className="h-20 w-20 rounded-full object-cover ring-4 ring-peko-50"
          />
        ) : (
          <span className="inline-flex h-20 w-20 items-center justify-center rounded-full bg-peko-100 text-2xl font-bold text-peko-700 ring-4 ring-peko-50">
            {getInitials(user.displayName)}
          </span>
        )}
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{user.displayName}</h1>
          <p className="text-gray-500">@{user.namespace}</p>
          {user.email && <p className="text-sm text-gray-400 mt-1">{user.email}</p>}
        </div>
      </div>

      {/* API Keys */}
      <div className="mt-10">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
            <Key className="h-5 w-5 text-peko-600" />
            API Keys
          </h2>
          <button
            onClick={loadApiKeys}
            className="btn-secondary text-xs py-1.5"
            disabled={keysLoading}
          >
            {keysLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Refresh'}
          </button>
        </div>

        {generatedKey && (
          <div className="mt-4 rounded-lg border border-green-200 bg-green-50 p-4">
            <p className="text-sm font-medium text-green-800">Your new API key (copy it now — it won't be shown again):</p>
            <code className="mt-2 block rounded bg-green-100 px-3 py-2 text-sm font-mono text-green-900 break-all">
              {generatedKey}
            </code>
            <button
              onClick={() => setGeneratedKey(null)}
              className="mt-2 text-xs text-green-700 hover:underline"
            >
              Dismiss
            </button>
          </div>
        )}

        <div className="mt-4 flex flex-col sm:flex-row gap-2">
          <input
            type="text"
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
            placeholder="Key name (e.g. 'CLI laptop')"
            className="input flex-1"
          />
          <button
            onClick={handleGenerateKey}
            className="btn-primary whitespace-nowrap"
            disabled={!newKeyName.trim()}
          >
            Generate Key
          </button>
        </div>

        {apiKeys.length === 0 && !keysLoading ? (
          <p className="mt-4 text-sm text-gray-500">No API keys yet. Generate one to use with the CLI.</p>
        ) : (
          <div className="mt-4 divide-y divide-gray-200 border rounded-lg">
            {apiKeys.map((key) => (
              <div key={key.id} className="flex items-center justify-between px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-gray-900">{key.name}</p>
                  <p className="text-xs text-gray-500">
                    {key.prefix}... • Created {new Date(key.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <button
                  onClick={() => handleRevokeKey(key.id)}
                  className="text-xs text-red-600 hover:text-red-700 font-medium"
                >
                  Revoke
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* My Bundles */}
      <div className="mt-10">
        <h2 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
          <Package className="h-5 w-5 text-peko-600" />
          My Bundles
        </h2>
        {search.isLoading && (
          <div className="mt-6 text-center text-gray-500">Loading...</div>
        )}
        {search.data && search.data.items.length > 0 && (
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {search.data.items.map((bundle) => (
              <BundleCard key={`${bundle.namespace}/${bundle.name}`} bundle={bundle} />
            ))}
          </div>
        )}
        {search.data?.items.length === 0 && (
          <p className="mt-4 text-sm text-gray-500">
            No bundles published yet.{' '}
            <a href="#" className="text-peko-600 hover:underline">
              Learn how to publish
            </a>
          </p>
        )}
      </div>
    </div>
  );
}

function getInitials(name: string): string {
  return name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}
