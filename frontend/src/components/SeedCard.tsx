import { Link } from '@tanstack/react-router';
import { ArrowUpRight, Cpu, Download } from 'lucide-react';
import { compactNumber, relativeTime } from '~/lib/format';
import { Badge } from '~/components/ui';

/**
 * A seed in the registry: the stripped `principal.toml` a peko grows from
 * (runtime ADR-060), named `<owner>/<name>`. It is a seed rather than a
 * template because `peko create` mints a fresh identity from it.
 *
 * Takes the fields both the listing (`GET /v1/seeds`) and search hits
 * carry, so either can render it.
 */
export interface SeedCardItem {
  owner: string;
  name: string;
  displayName?: string | null;
  description?: string | null;
  avatar?: string | null;
  model?: string | null;
  pullCount: number;
  updatedAt: string;
}

/** `showKind`: label it a seed, where results mix kinds (search). */
export function SeedCard({ item, showKind = false }: { item: SeedCardItem; showKind?: boolean }) {
  return (
    <Link
      to="/$owner/$name"
      params={{ owner: item.owner, name: item.name }}
      className="card card-hover group flex flex-col p-5"
    >
      <header className="flex items-start gap-3">
        <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border border-iris-400/20 bg-iris-400/[0.07] text-base">
          {item.avatar ?? <span className="font-mono text-xs text-iris-300">{item.name.slice(0, 2)}</span>}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-[15px] font-semibold tracking-tight text-slate-100">
              {item.displayName ?? item.name}
            </h3>
            {showKind && <Badge tone="iris">seed</Badge>}
          </div>
          <p className="truncate font-mono text-2xs text-slate-500">
            {item.owner}/{item.name}
          </p>
        </div>
        <ArrowUpRight className="h-4 w-4 flex-shrink-0 text-slate-600 transition-colors group-hover:text-iris-300" />
      </header>

      <p className="mt-3 line-clamp-3 min-h-[3.4rem] text-[13px] leading-relaxed text-slate-400">
        {item.description ?? 'No description yet.'}
      </p>

      <div className="mt-auto flex items-center gap-4 pt-5 font-mono text-2xs text-slate-600">
        <span className="flex items-center gap-1.5" title="Downloads">
          <Download className="h-3 w-3" />
          {compactNumber(item.pullCount)}
        </span>
        {item.model && (
          <span className="flex min-w-0 items-center gap-1.5" title="Written for this model">
            <Cpu className="h-3 w-3 flex-shrink-0" />
            <span className="truncate">{item.model}</span>
          </span>
        )}
        <span className="ml-auto flex-shrink-0">{relativeTime(item.updatedAt)}</span>
      </div>
    </Link>
  );
}
