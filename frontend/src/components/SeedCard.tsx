import { Link } from '@tanstack/react-router';
import { Download } from 'lucide-react';
import { compactNumber, relativeTime } from '~/lib/format';
import { Tile } from '~/components/ui';

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
  /** Absent on an exact-ID match, which carries no counts. */
  pullCount?: number;
  updatedAt?: string;
}

export function SeedCard({ item }: { item: SeedCardItem }) {
  return (
    <Link
      to="/$owner/$name"
      params={{ owner: item.owner, name: item.name }}
      className="card card-hover flex flex-col p-5"
    >
      <header className="flex items-center gap-3">
        <Tile avatar={item.avatar} name={item.name} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[15px] font-medium text-slate-100">
            {item.displayName ?? item.name}
          </h3>
          <p className="truncate text-xs text-slate-500">
            {item.owner}/{item.name}
          </p>
        </div>
      </header>

      {item.description && (
        <p className="mt-3 line-clamp-2 text-[13px] leading-relaxed text-slate-400">{item.description}</p>
      )}

      <div className="mt-auto flex items-center gap-4 pt-4 text-xs text-slate-500">
        {item.pullCount !== undefined && (
          <span className="flex items-center gap-1.5" title="Downloads">
            <Download className="h-3 w-3" />
            {compactNumber(item.pullCount)}
          </span>
        )}
        {item.model && <span className="truncate">{item.model}</span>}
        {item.updatedAt && <span className="ml-auto flex-shrink-0">{relativeTime(item.updatedAt)}</span>}
      </div>
    </Link>
  );
}
