import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useBundle } from '~/hooks/useBundle';
import { useAuth } from '~/hooks/useAuth';
import { Download, Star, Copy, Check, AlertTriangle, GitFork, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api } from '~/lib/api';
import { useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export const Route = createFileRoute('/bundles/$namespace/$name')({
  component: BundleDetailPage,
});

function BundleDetailPage() {
  const { namespace, name } = Route.useParams();
  const bundle = useBundle(namespace, name);
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);
  const [deprecating, setDeprecating] = useState<string | null>(null);
  const [deprecateMessage, setDeprecateMessage] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [forking, setForking] = useState(false);

  const isOwner = user?.namespace === namespace;
  const isAuthenticated = !!user;

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDeprecate = async (version: string, deprecated: boolean) => {
    try {
      await api.deprecateVersion(namespace, name, version, deprecated, deprecateMessage || undefined);
      queryClient.invalidateQueries({ queryKey: ['bundle', namespace, name] });
      setDeprecating(null);
      setDeprecateMessage('');
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to update deprecation');
    }
  };

  const handleDeleteVersion = async (version: string) => {
    if (!confirm(`Delete version ${version}? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      await api.deleteVersion(namespace, name, version);
      queryClient.invalidateQueries({ queryKey: ['bundle', namespace, name] });
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete version');
    } finally {
      setDeleting(false);
    }
  };

  const handleDeleteBundle = async () => {
    if (!confirm(`Delete ${namespace}/${name} and all its versions? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      await api.deleteBundle(namespace, name);
      navigate({ to: '/' });
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete bundle');
    } finally {
      setDeleting(false);
    }
  };

  const handleFork = async () => {
    if (!isAuthenticated) {
      alert('Please sign in to fork bundles');
      return;
    }
    setForking(true);
    try {
      const result = await api.forkBundle(namespace, name);
      navigate({ to: `/bundles/${result.namespace}/${result.name}` });
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to fork bundle');
    } finally {
      setForking(false);
    }
  };

  if (bundle.isLoading) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-12 text-center text-gray-500">
        Loading...
      </div>
    );
  }

  if (bundle.isError || !bundle.data) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-12 text-center text-red-600">
        Bundle not found
      </div>
    );
  }

  const data = bundle.data;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 break-words">
            {data.namespace}/{data.name}
          </h1>
          <p className="mt-2 text-gray-600">{data.metadata.description}</p>
        </div>
        <span className="inline-flex items-center self-start rounded-full bg-peko-50 px-3 py-1 text-sm font-medium text-peko-700">
          {data.metadata.bundleType}
        </span>
      </div>

      {/* Stats */}
      <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-gray-500">
        <span className="flex items-center gap-1">
          <Download className="h-4 w-4" />
          {data.pullCount.allTime.toLocaleString()} pulls
        </span>
        <span className="flex items-center gap-1">
          <Star className="h-4 w-4" />
          {data.metadata.author ?? 'unknown'}
        </span>
        {data.metadata.forkedFrom && (
          <span className="flex items-center gap-1">
            <GitFork className="h-4 w-4" />
            forked from {data.metadata.forkedFrom}
          </span>
        )}
      </div>

      {/* Actions */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          onClick={handleFork}
          disabled={forking || deleting}
          className="btn-secondary text-sm py-1.5 inline-flex items-center gap-1 disabled:opacity-50"
        >
          <GitFork className="h-4 w-4" />
          {forking ? 'Forking...' : 'Fork'}
        </button>
        {isOwner && (
          <button
            onClick={handleDeleteBundle}
            disabled={deleting}
            className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm font-medium text-red-600 bg-red-50 hover:bg-red-100 transition-colors disabled:opacity-50"
          >
            <Trash2 className="h-4 w-4" />
            {deleting ? 'Deleting...' : 'Delete'}
          </button>
        )}
      </div>

      {/* Install command */}
      <div className="mt-8">
        <label className="text-sm font-medium text-gray-700">Install</label>
        <div className="mt-2 flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
          <code className="flex-1 rounded-lg bg-gray-900 px-4 py-3 text-sm text-gray-100 font-mono break-all">
            {data.installCommand}
          </code>
          <button
            onClick={() => handleCopy(data.installCommand)}
            className="btn-secondary p-3 self-start sm:self-auto"
            title="Copy to clipboard"
          >
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {/* README */}
      {data.readme && (
        <div className="mt-10">
          <h2 className="text-xl font-semibold text-gray-900">README</h2>
          <div className="mt-4 prose prose-gray max-w-none">
            <div className="markdown-body bg-gray-50 rounded-lg p-4">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {data.readme}
              </ReactMarkdown>
            </div>
          </div>
        </div>
      )}

      {/* Versions */}
      <div className="mt-10">
        <h2 className="text-xl font-semibold text-gray-900">Versions</h2>
        <div className="mt-4 divide-y divide-gray-200 border rounded-lg">
          {data.versions.map((v) => (
            <div key={v.version} className="px-4 py-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-mono text-sm">{v.version}</span>
                  {v.deprecated && (
                    <span className="inline-flex items-center gap-1 rounded-md bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                      <AlertTriangle className="h-3 w-3" />
                      Deprecated
                    </span>
                  )}
                </div>
                <span className="text-xs text-gray-500">
                  {new Date(v.createdAt).toLocaleDateString()}
                </span>
              </div>
              {v.deprecatedMessage && (
                <p className="mt-1 text-xs text-amber-700">{v.deprecatedMessage}</p>
              )}
              {isOwner && (
                <>
                  {deprecating === v.version ? (
                    <div className="mt-2 flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                      <input
                        type="text"
                        placeholder="Deprecation reason (optional)"
                        value={deprecateMessage}
                        onChange={(e) => setDeprecateMessage(e.target.value)}
                        className="flex-1 rounded-md border border-gray-300 px-2 py-1 text-sm focus:border-peko-500 focus:outline-none"
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleDeprecate(v.version, true)}
                          className="rounded-md bg-amber-600 px-2 py-1 text-xs font-medium text-white hover:bg-amber-700"
                        >
                          Deprecate
                        </button>
                        <button
                          onClick={() => { setDeprecating(null); setDeprecateMessage(''); }}
                          className="rounded-md bg-gray-100 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-200"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-2 flex items-center gap-2">
                      {v.deprecated ? (
                        <button
                          onClick={() => handleDeprecate(v.version, false)}
                          className="rounded-md bg-gray-100 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-200"
                        >
                          Un-deprecate
                        </button>
                      ) : (
                        <button
                          onClick={() => setDeprecating(v.version)}
                          className="rounded-md bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700 hover:bg-amber-100"
                        >
                          Deprecate
                        </button>
                      )}
                      <button
                        onClick={() => handleDeleteVersion(v.version)}
                        className="rounded-md bg-red-50 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-100"
                        title="Delete version"
                      >
                        <Trash2 className="h-3 w-3 inline mr-1" />
                        Delete
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
