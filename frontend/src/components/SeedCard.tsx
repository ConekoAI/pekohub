import { Link } from '@tanstack/react-router';
import { ArrowUpRight, ChevronRight, Download, GitBranch, TriangleAlert } from 'lucide-react';
import type { SearchResultItem } from '@pekohub/shared';
import { Badge, CopyButton } from '~/components/ui';
import { compactNumber, relativeTime } from '~/lib/format';
import { classifyRepo, laneLabel, type RepoRef } from '~/lib/repo';

/**
 * A registry seed.
 *
 * The hub is seed-only (runtime ADR-056 D6): a pushed artifact is
 * DNA — a stripped `principal.toml` — carried as a zero-layer OCI
 * manifest under `peko/principals/<name>`. There is no extension
 * package format any more (runtime ADR-047 §5 / ADR-050 moved
 * capabilities into plain workspace files), so the card shows only the
 * seed's identity, provenance and version.
 *
 * It is a seed rather than a template because `peko create` mints a
 * fresh identity from it — see runtime ADR-060.
 */
export function SeedCard({ item }: { item: SearchResultItem }) {
  const repo = `${item.namespace}/${item.name}`;
  const installRef = `${repo}:${item.version}`;

  return (
    <article className="card card-hover group flex flex-col p-5">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-mono text-2xs text-slate-500">{item.namespace}/</p>
          <h3 className="truncate text-[15px] font-semibold tracking-tight text-slate-100">
            {item.name}
          </h3>
        </div>
        <Badge tone="iris">seed</Badge>
      </header>

      <p className="mt-3 line-clamp-3 min-h-[3.4rem] text-[13px] leading-relaxed text-slate-400">
        {item.description ?? 'No description provided.'}
      </p>

      {item.tags && item.tags.length > 0 && (
        <div className="mt-3.5 flex flex-wrap items-center gap-1.5">
          {item.tags.slice(0, 4).map((tag) => (
            <span
              key={tag}
              className="rounded-md border border-white/[0.06] bg-white/[0.03] px-1.5 py-0.5 font-mono text-2xs text-slate-500"
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      <div className="mt-auto pt-5">
        <div className="flex items-center gap-4 font-mono text-2xs text-slate-600">
          <span className="flex items-center gap-1.5">
            <Download className="h-3 w-3" />
            {compactNumber(item.pullCount)}
          </span>
          <span className="flex items-center gap-1.5">
            <GitBranch className="h-3 w-3" />
            {item.version}
          </span>
          <span className="ml-auto">{relativeTime(item.updatedAt)}</span>
        </div>

        <div className="mt-4 flex items-center justify-between gap-2 border-t border-white/[0.06] pt-4">
          <CopyButton value={installRef} label="Ref" className="btn-ghost btn-sm" />
          <Link
            to="/seeds/$"
            params={{ _splat: repo }}
            className="btn-secondary btn-sm group-hover:border-iris-400/40 group-hover:text-iris-200"
          >
            Details
            <ArrowUpRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </div>
    </article>
  );
}

/**
 * A catalog entry (the repository paths themselves, straight from
 * `GET /v2/_catalog`).
 *
 * Catalog entries carry no metadata, so the row is deliberately thin —
 * it exists to make the registry's real contents legible and to link
 * into the detail page, which resolves the rest.
 */
export function SeedRepoRow({ entry }: { entry: RepoRef }) {
  return (
    <Link
      to="/seeds/$"
      params={{ _splat: entry.repo }}
      className="group flex items-center gap-4 rounded-lg border border-white/[0.06] bg-white/[0.015] px-4 py-3.5 transition-all duration-150 hover:border-iris-400/25 hover:bg-white/[0.035]"
    >
      <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border border-iris-400/20 bg-iris-400/[0.08] font-mono text-2xs text-iris-300">
        {entry.name.slice(0, 2).toUpperCase()}
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5">
          <span className="truncate font-mono text-2xs text-slate-500">{entry.namespace}/</span>
          <span className="truncate text-sm font-medium text-slate-200">{entry.name}</span>
        </span>
        <span className="mt-0.5 flex items-center gap-1.5">
          <span className="font-mono text-2xs text-slate-600">{laneLabel(entry.lane)}</span>
          {entry.isRetired && (
            <span className="badge-warn">
              <TriangleAlert className="h-2.5 w-2.5" />
              retired lane
            </span>
          )}
        </span>
      </span>

      <ChevronRight className="h-4 w-4 flex-shrink-0 text-slate-600 transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-iris-300" />
    </Link>
  );
}

/** Convenience: classify then render, skipping anything unparseable. */
export function isSeedRepo(repo: string): boolean {
  const parsed = classifyRepo(repo);
  return parsed !== null && parsed.isSeed;
}
