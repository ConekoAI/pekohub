import { Link } from '@tanstack/react-router';
import { Download } from 'lucide-react';
import { compactNumber, relativeTime } from '~/lib/format';
import { Badge, Tile } from '~/components/ui';

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
      className="card card-hover flex flex-col p-5"
    >
      <header className="flex items-center gap-3">
        <Tile avatar={item.avatar} name={item.name} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-[15px] font-medium text-slate-100">
              {item.displayName ?? item.name}
            </h3>
            {showKind && <Badge>seed</Badge>}
          </div>
          <p className="truncate text-xs text-slate-500">
            {item.owner}/{item.name}
          </p>
        </div>
      </header>

      {item.description && (
        <p className="mt-3 line-clamp-2 text-[13px] leading-relaxed text-slate-400">{item.description}</p>
      )}

      <div className="mt-auto flex items-center gap-4 pt-4 text-xs text-slate-500">
        <span className="flex items-center gap-1.5" title="Downloads">
          <Download className="h-3 w-3" />
          {compactNumber(item.pullCount)}
        </span>
        {item.model && <span className="truncate">{item.model}</span>}
        <span className="ml-auto flex-shrink-0">{relativeTime(item.updatedAt)}</span>
      </div>
    </Link>
  );
}
