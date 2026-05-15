import { createFileRoute } from '@tanstack/react-router';
import { useBundle } from '~/hooks/useBundle';
import { Download, Star, Copy, Check } from 'lucide-react';
import { useState } from 'react';

export const Route = createFileRoute('/bundles/$namespace/$name')({
  component: BundleDetailPage,
});

function BundleDetailPage() {
  const { namespace, name } = Route.useParams();
  const bundle = useBundle(namespace, name);
  const [copied, setCopied] = useState(false);

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
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
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">
            {data.namespace}/{data.name}
          </h1>
          <p className="mt-2 text-gray-600">{data.metadata.description}</p>
        </div>
        <span className="inline-flex items-center rounded-full bg-peko-50 px-3 py-1 text-sm font-medium text-peko-700">
          {data.metadata.bundleType}
        </span>
      </div>

      {/* Stats */}
      <div className="mt-6 flex items-center gap-6 text-sm text-gray-500">
        <span className="flex items-center gap-1">
          <Download className="h-4 w-4" />
          {data.pullCount.allTime.toLocaleString()} pulls
        </span>
        <span className="flex items-center gap-1">
          <Star className="h-4 w-4" />
          {data.metadata.author}
        </span>
      </div>

      {/* Install command */}
      <div className="mt-8">
        <label className="text-sm font-medium text-gray-700">Install</label>
        <div className="mt-2 flex items-center gap-2">
          <code className="flex-1 rounded-lg bg-gray-900 px-4 py-3 text-sm text-gray-100 font-mono">
            {data.installCommand}
          </code>
          <button
            onClick={() => handleCopy(data.installCommand)}
            className="btn-secondary p-3"
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
            <pre className="whitespace-pre-wrap text-sm text-gray-700 bg-gray-50 rounded-lg p-4">
              {data.readme}
            </pre>
          </div>
        </div>
      )}

      {/* Versions */}
      <div className="mt-10">
        <h2 className="text-xl font-semibold text-gray-900">Versions</h2>
        <div className="mt-4 divide-y divide-gray-200 border rounded-lg">
          {data.versions.map((v) => (
            <div key={v.version} className="flex items-center justify-between px-4 py-3">
              <span className="font-mono text-sm">{v.version}</span>
              <span className="text-xs text-gray-500">
                {new Date(v.createdAt).toLocaleDateString()}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
