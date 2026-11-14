/**
 * Shared UI atoms for PekoHub.
 *
 * Everything visual that more than one page needs lives here so the
 * pages compose instead of re-deriving colour math. All colours come
 * from `tailwind.config.js` (ink / peko) — never hardcode a hex in a page.
 */

import { useState, type ReactNode } from 'react';
import { AlertTriangle, Check, Copy, Loader2 } from 'lucide-react';
import { initials } from '~/lib/format';

/* ─────────────────────────────────────────────────────────────────────────
   Avatars
   ───────────────────────────────────────────────────────────────────────── */

export function Avatar({
  name,
  src,
  size = 'md',
}: {
  name: string;
  src?: string | null;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
}) {
  const dims = {
    xs: 'h-5 w-5 text-[9px]',
    sm: 'h-7 w-7 text-[11px]',
    md: 'h-9 w-9 text-xs',
    lg: 'h-14 w-14 text-base',
    xl: 'h-16 w-16 text-lg',
  }[size];

  if (src) {
    return (
      <img
        src={src}
        alt={name}
        className={`${dims} flex-shrink-0 rounded-full border border-ink-600 object-cover`}
      />
    );
  }

  return (
    <span
      aria-hidden
      className={`${dims} flex flex-shrink-0 items-center justify-center rounded-full bg-ink-700 font-semibold text-slate-100`}
    >
      {initials(name) || '?'}
    </span>
  );
}

/** A peko's or seed's tile: its emoji avatar, else the first two letters. */
export function Tile({
  avatar,
  name,
  size = 'md',
}: {
  avatar?: string | null;
  name: string;
  size?: 'md' | 'lg';
}) {
  const dims = size === 'lg' ? 'h-14 w-14 rounded-xl text-2xl' : 'h-9 w-9 text-base';
  return (
    <span className={`tile ${dims}`} aria-hidden>
      {avatar ?? <span className={size === 'lg' ? 'text-base' : 'text-xs'}>{name.slice(0, 2)}</span>}
    </span>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   Layout
   ───────────────────────────────────────────────────────────────────────── */

/** A section's title row with an optional right-aligned control. */
export function SectionTitle({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="mb-4 flex items-center justify-between gap-4">
      <h2 className="h-section">{title}</h2>
      {action}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   Badges & status
   ───────────────────────────────────────────────────────────────────────── */

export type BadgeTone = 'accent' | 'neutral' | 'danger';

/** Spelled out: Tailwind keeps only the class names it finds whole in the source. */
const BADGE: Record<BadgeTone, string> = {
  accent: 'badge-accent',
  neutral: 'badge-neutral',
  danger: 'badge-danger',
};

export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={BADGE[tone]}>{children}</span>;
}

const DOT: Record<string, string> = {
  online: 'bg-peko-400 shadow-[0_0_0_3px_rgba(78,184,175,0.2)]',
  busy: 'bg-slate-400',
  error: 'bg-rose-400',
  offline: 'bg-slate-600',
};

export function StatusDot({ status }: { status: string }) {
  return (
    <span
      className={`inline-block h-2 w-2 flex-shrink-0 rounded-full ${DOT[status] ?? DOT.offline}`}
      aria-hidden
    />
  );
}

export function StatusPill({ status }: { status: string }) {
  const known = status in DOT ? status : 'offline';
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-slate-400">
      <StatusDot status={known} />
      {known}
    </span>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   Feedback
   ───────────────────────────────────────────────────────────────────────── */

export function Spinner({ className = 'h-5 w-5' }: { className?: string }) {
  return <Loader2 className={`animate-spin text-slate-500 ${className}`} aria-hidden />;
}

export function Loading({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2.5 py-24 text-sm text-slate-500">
      <Spinner className="h-4 w-4" />
      {label}
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-rose-400/20 bg-rose-400/[0.06] px-4 py-3 text-sm text-rose-200">
      <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-rose-300" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** The one "the hub isn't answering" message. */
export function Unavailable() {
  return <ErrorNote>PekoHub isn&apos;t answering. Try again in a moment.</ErrorNote>;
}

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon?: ReactNode;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed border-ink-600 px-6 py-14 text-center">
      {icon && <div className="mb-3 text-slate-500">{icon}</div>}
      <h3 className="text-sm font-medium text-slate-200">{title}</h3>
      {body && <div className="mt-1.5 max-w-sm text-sm text-slate-500">{body}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   Copy to clipboard
   ───────────────────────────────────────────────────────────────────────── */

export function CopyButton({
  value,
  label = 'Copy',
  className = 'btn-secondary btn-sm',
}: {
  value: string;
  /** Empty for an icon-only button. */
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      title={value}
      aria-label={label || 'Copy'}
      onClick={async () => {
        try {
          await navigator.clipboard?.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1800);
        } catch {
          // Clipboard is unavailable in insecure contexts — the button
          // stays inert and the `title` carries the raw value.
        }
      }}
      className={className}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-slate-100" /> : <Copy className="h-3.5 w-3.5" />}
      {label && (copied ? 'Copied' : label)}
    </button>
  );
}

/** A command or ID with a copy button beside it. */
export function CopyField({ value }: { value: string }) {
  return (
    <div className="flex items-center gap-1 rounded-lg border border-ink-700 bg-ink-950 py-1 pl-3.5 pr-1">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[12.5px] text-slate-200">
        {value}
      </code>
      <CopyButton value={value} label="" className="btn-icon" />
    </div>
  );
}
