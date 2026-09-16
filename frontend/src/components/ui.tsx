/**
 * Shared UI atoms for the PekoHub console.
 *
 * Everything visual that more than one page needs lives here so the
 * pages compose instead of re-deriving colour math. All colours come
 * from `tailwind.config.js` (ink / peko / iris) — never hardcode a hex
 * in a page.
 */

import { useState, type ReactNode } from 'react';
import { AlertTriangle, Check, Copy, Loader2, Wifi, WifiOff, Clock, CircleDot } from 'lucide-react';
import { initials } from '~/lib/format';

/* ─────────────────────────────────────────────────────────────────────────
   Avatar
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
    xs: 'h-5 w-5 text-[10px]',
    sm: 'h-7 w-7 text-[11px]',
    md: 'h-9 w-9 text-xs',
    lg: 'h-14 w-14 text-base',
    xl: 'h-20 w-20 text-2xl',
  }[size];

  if (src) {
    return (
      <img
        src={src}
        alt={name}
        className={`${dims} flex-shrink-0 rounded-full border border-white/10 object-cover`}
      />
    );
  }

  return (
    <span
      aria-hidden
      className={`${dims} flex flex-shrink-0 items-center justify-center rounded-full border border-peko-400/25 bg-peko-400/10 font-mono font-semibold text-peko-200`}
    >
      {initials(name) || '?'}
    </span>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   Typography
   ───────────────────────────────────────────────────────────────────────── */

export function Eyebrow({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <p className={`eyebrow ${className}`}>{children}</p>;
}

export function SectionHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && <Eyebrow className="mb-2">{eyebrow}</Eyebrow>}
        <h2 className="display text-xl sm:text-2xl">{title}</h2>
        {description && <p className="lede mt-1.5 max-w-2xl">{description}</p>}
      </div>
      {action && <div className="flex-shrink-0">{action}</div>}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   Badges & status
   ───────────────────────────────────────────────────────────────────────── */

export type BadgeTone = 'peko' | 'iris' | 'neutral' | 'warn' | 'danger';

export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={`badge-${tone}`}>{children}</span>;
}

const STATUS_STYLE: Record<
  string,
  { label: string; dot: string; text: string; ring: string; Icon: typeof Wifi }
> = {
  online: {
    label: 'online',
    dot: 'bg-emerald-400',
    text: 'text-emerald-300',
    ring: 'border-emerald-400/25 bg-emerald-400/10',
    Icon: Wifi,
  },
  busy: {
    label: 'busy',
    dot: 'bg-amber-400',
    text: 'text-amber-300',
    ring: 'border-amber-400/25 bg-amber-400/10',
    Icon: Clock,
  },
  error: {
    label: 'error',
    dot: 'bg-rose-400',
    text: 'text-rose-300',
    ring: 'border-rose-400/25 bg-rose-400/10',
    Icon: AlertTriangle,
  },
  offline: {
    label: 'offline',
    dot: 'bg-slate-500',
    text: 'text-slate-400',
    ring: 'border-ink-600 bg-ink-800',
    Icon: WifiOff,
  },
};

export function StatusDot({ status }: { status: string }) {
  const style = STATUS_STYLE[status] ?? STATUS_STYLE.offline;
  return (
    <span
      className={`inline-block h-2 w-2 flex-shrink-0 rounded-full ${style.dot} ${
        status === 'online' ? 'animate-pulse-ring' : ''
      }`}
      aria-hidden
    />
  );
}

export function StatusPill({ status }: { status: string }) {
  const style = STATUS_STYLE[status] ?? STATUS_STYLE.offline;
  const { Icon } = style;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-2xs uppercase tracking-wider ${style.ring} ${style.text}`}
    >
      <Icon className="h-3 w-3" />
      {style.label}
    </span>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   Feedback
   ───────────────────────────────────────────────────────────────────────── */

export function Spinner({ className = 'h-5 w-5' }: { className?: string }) {
  return <Loader2 className={`animate-spin text-peko-400 ${className}`} aria-hidden />;
}

export function LoadingBlock({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2.5 py-20 text-sm text-slate-500">
      <Spinner className="h-4 w-4" />
      {label}…
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-rose-400/25 bg-rose-500/[0.07] px-4 py-3 text-sm text-rose-200">
      <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-rose-400" />
      <div className="min-w-0">{children}</div>
    </div>
  );
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
    <div className="well flex flex-col items-center px-6 py-14 text-center">
      {icon && (
        <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl border border-white/[0.07] bg-ink-800 text-slate-500">
          {icon}
        </div>
      )}
      <h3 className="text-sm font-semibold text-slate-200">{title}</h3>
      {body && <div className="mt-1.5 max-w-md text-sm text-slate-500">{body}</div>}
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
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      title={value}
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
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? 'Copied' : label}
    </button>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   Decorative backdrop
   ───────────────────────────────────────────────────────────────────────── */

export function Backdrop() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[560px] overflow-hidden">
      <div className="grid-bg" />
      <div className="glow-orb left-[6%] top-[-140px] h-[380px] w-[380px] animate-drift bg-peko-500/20" />
      <div
        className="glow-orb right-[4%] top-[-180px] h-[420px] w-[420px] animate-drift bg-iris-500/20"
        style={{ animationDelay: '-4s' }}
      />
      <div className="absolute inset-x-0 top-[420px] h-[160px] bg-gradient-to-b from-transparent to-ink-950" />
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   Readouts
   ───────────────────────────────────────────────────────────────────────── */

export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3.5 py-3">
      <p className="eyebrow">{label}</p>
      <p className="mt-1.5 flex items-center gap-1.5 text-lg font-semibold tracking-tight text-slate-100">
        {value}
      </p>
      {hint && <p className="mt-0.5 text-2xs text-slate-600">{hint}</p>}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

/** Inline mono readout used for DIDs, repo paths and digests. */
export function Mono({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 font-mono text-2xs text-slate-500 ${className}`}>
      <CircleDot className="h-2.5 w-2.5 flex-shrink-0 text-slate-600" aria-hidden />
      <span className="truncate">{children}</span>
    </span>
  );
}
