import { Link } from '@tanstack/react-router';
import { ArrowUpRight, Sparkles } from 'lucide-react';
import type { DiscoveryHit } from '~/lib/api';
import { ownerHandle, shareUrlFor } from '~/lib/api';
import { Badge, CopyButton, StatusPill } from '~/components/ui';
import { relativeTime } from '~/lib/format';

/**
 * One peko in the public directory.
 *
 * A peko is a live actor on somebody's runtime (ADR-059), so the card
 * leads with liveness — status, owner, and how recently it was seen —
 * and offers the two things a visitor can actually do: open the chat,
 * or copy the share link.
 */
export function PekoCard({ hit }: { hit: DiscoveryHit }) {
  const shareUrl = shareUrlFor(hit);

  return (
    <article className="card card-hover group flex flex-col p-5">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-[15px] font-semibold tracking-tight text-slate-100">
            {hit.publicName}
          </h3>
          <p className="mt-1 truncate font-mono text-2xs text-slate-500">
            @{hit.ownerNamespace ?? hit.ownerName}
          </p>
        </div>
        {hit.featured ? (
          <Badge tone="warn">
            <Sparkles className="h-3 w-3" />
            featured
          </Badge>
        ) : (
          <StatusPill status={hit.status} />
        )}
      </header>

      <p className="mt-3 line-clamp-3 min-h-[3.4rem] text-[13px] leading-relaxed text-slate-400">
        {hit.description ?? 'No description provided.'}
      </p>

      <div className="mt-3.5 flex flex-wrap items-center gap-1.5">
        {hit.category && <Badge tone="peko">{hit.category}</Badge>}
        {hit.tags.slice(0, 3).map((tag) => (
          <span
            key={tag}
            className="rounded-md border border-white/[0.06] bg-white/[0.03] px-1.5 py-0.5 font-mono text-2xs text-slate-500"
          >
            {tag}
          </span>
        ))}
      </div>

      <div className="mt-auto flex items-center justify-between gap-2 pt-5">
        <span className="font-mono text-2xs text-slate-600">
          {hit.publishedAt ? `published ${relativeTime(hit.publishedAt)}` : 'unpublished'}
        </span>
        <div className="flex items-center gap-1.5">
          <CopyButton value={shareUrl} label="Link" className="btn-ghost btn-sm" />
          <Link
            to="/peko/$owner/$pekoName"
            params={{ owner: ownerHandle(hit), pekoName: hit.publicName }}
            className="btn-secondary btn-sm group-hover:border-peko-400/40 group-hover:text-peko-200"
          >
            Open
            <ArrowUpRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </div>
    </article>
  );
}
