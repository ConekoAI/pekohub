import { Link } from '@tanstack/react-router';
import { Download, Star, Tag } from 'lucide-react';
import type { SearchResultItem } from '@pekohub/shared';

interface BundleCardProps {
  bundle: SearchResultItem;
}

export function BundleCard({ bundle }: BundleCardProps) {
  return (
    <Link
      to="/bundles/$namespace/$name"
      params={{ namespace: bundle.namespace, name: bundle.name }}
      className="card p-5 hover:shadow-md transition-shadow"
    >
      <div className="flex items-start justify-between">
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold text-gray-900 truncate">
            {bundle.namespace}/{bundle.name}
          </h3>
          <p className="mt-1 text-sm text-gray-500 line-clamp-2">
            {bundle.description ?? 'No description'}
          </p>
        </div>
        <span className="ml-3 inline-flex items-center rounded-full bg-peko-50 px-2.5 py-0.5 text-xs font-medium text-peko-700">
          {bundle.bundleType}
        </span>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-gray-500">
        <span className="flex items-center gap-1">
          <Download className="h-4 w-4" />
          {bundle.pullCount.toLocaleString()}
        </span>
        <span className="flex items-center gap-1">
          <Star className="h-4 w-4" />
          {bundle.starCount.toLocaleString()}
        </span>
        <span className="text-gray-400">v{bundle.version}</span>
      </div>

      {bundle.tags && bundle.tags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {bundle.tags.slice(0, 5).map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 rounded-md bg-gray-100 px-2 py-0.5 text-xs text-gray-600"
            >
              <Tag className="h-3 w-3" />
              {tag}
            </span>
          ))}
        </div>
      )}
    </Link>
  );
}
