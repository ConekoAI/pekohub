import { Link } from '@tanstack/react-router';
import { ExternalLink, Plus, Star } from 'lucide-react';
import type { DiscoveryHit } from '~/lib/api';
import { shareUrlFor } from '~/lib/api';

/**
 * PR #8: Discovery card. Renders one row in the search/feed grid
 * with two actions:
 *
 * 1. "Open" → /peko/$owner/$pekoName (in-browser public chat)
 * 2. "Copy link" → copies the share URL to the clipboard.
 *
 * Visual contract: card width is determined by the parent grid;
 * the card itself caps at `max-w-sm` so 3-up layouts stay tidy.
 */
export function PekoCard({ hit }: { hit: DiscoveryHit }) {
  const shareUrl = shareUrlFor(hit);

  return (
    <article className="card flex max-w-sm flex-col p-4">
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate font-semibold text-gray-900">{hit.publicName}</h3>
          <p className="mt-0.5 truncate text-xs text-gray-500">@{hit.ownerName}</p>
        </div>
        {hit.featured && (
          <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
            <Star className="h-3 w-3" />
            Featured
          </span>
        )}
      </header>

      {hit.description && (
        <p className="mt-2 line-clamp-3 text-sm text-gray-600">{hit.description}</p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {hit.category && (
          <span className="rounded-full bg-peko-100 px-2 py-0.5 text-xs font-medium text-peko-700">
            {hit.category}
          </span>
        )}
        {hit.tags.slice(0, 3).map((t) => (
          <span key={t} className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
            {t}
          </span>
        ))}
      </div>

      <footer className="mt-4 flex items-center justify-between gap-2">
        <Link
          to="/peko/$owner/$pekoName"
          params={{ owner: hit.ownerName, pekoName: hit.publicName }}
          target="_blank"
          className="inline-flex items-center gap-1 text-xs font-medium text-peko-600 hover:underline"
        >
          <ExternalLink className="h-3 w-3" />
          Open
        </Link>
        <CopyLinkButton url={shareUrl} />
      </footer>
    </article>
  );
}

function CopyLinkButton({ url }: { url: string }) {
  // Inline button so the card stays self-contained. The `navigator.clipboard`
  // call is best-effort; if it fails (insecure context / no permission),
  // we still render the URL in a `title` so the user can drag-select it.
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard?.writeText(url);
        } catch {
          // ignored — see comment above
        }
      }}
      title={url}
      className="btn-secondary inline-flex items-center gap-1 text-xs py-1"
    >
      <Plus className="h-3 w-3" />
      Copy link
    </button>
  );
}
