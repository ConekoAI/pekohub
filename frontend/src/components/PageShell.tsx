import type { ReactNode } from 'react';

/**
 * Public page container: the standard max-width gutter and vertical
 * rhythm. Every top-level page uses this so pages only supply content.
 */
export function PageShell({
  children,
  width = 'default',
}: {
  children: ReactNode;
  /** `wide` for directories, `default` for detail pages, `narrow` for reading. */
  width?: 'default' | 'wide' | 'narrow';
}) {
  const max = {
    narrow: 'max-w-2xl',
    default: 'max-w-5xl',
    wide: 'max-w-6xl',
  }[width];

  return <div className={`mx-auto ${max} animate-fade-in px-5 pb-20 pt-12 sm:px-8`}>{children}</div>;
}

/** Page title with an optional one-line subtitle and a right-aligned control. */
export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="h-page">{title}</h1>
        {subtitle && <p className="mt-1.5 text-sm text-slate-400">{subtitle}</p>}
      </div>
      {action && <div className="flex flex-shrink-0 items-center gap-2">{action}</div>}
    </header>
  );
}
