import type { ReactNode } from 'react';
import { Backdrop } from '~/components/ui';

/**
 * Public page container.
 *
 * Wraps a route in the shared backdrop (graph-paper grid + brand glow)
 * and the standard max-width gutter. Every top-level page uses this so
 * the vertical rhythm and the decorative layer stay identical across
 * routes — pages only supply content.
 */
export function PageShell({
  children,
  width = 'default',
}: {
  children: ReactNode;
  /** `wide` for directories, `default` for detail/reading pages. */
  width?: 'default' | 'wide' | 'narrow';
}) {
  const max = {
    narrow: 'max-w-3xl',
    default: 'max-w-5xl',
    wide: 'max-w-7xl',
  }[width];

  return (
    <div className="relative isolate">
      <Backdrop />
      <div className={`mx-auto ${max} px-4 pb-16 pt-10 sm:px-6 lg:px-8`}>{children}</div>
    </div>
  );
}

/**
 * Page title block. `eyebrow` carries the mono readout label, `action`
 * a right-aligned control (filter, refresh, CTA).
 */
export function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-5">
      <div className="min-w-0">
        {eyebrow && <p className="eyebrow mb-2.5">{eyebrow}</p>}
        <h1 className="display text-2xl sm:text-[28px]">{title}</h1>
        {description && <p className="lede mt-2 max-w-2xl">{description}</p>}
      </div>
      {action && <div className="flex flex-shrink-0 items-center gap-2">{action}</div>}
    </header>
  );
}
