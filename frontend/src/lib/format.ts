/**
 * Formatting helpers shared across pages.
 *
 * Display-only — no business logic. Keep these pure so they can be
 * unit-tested and called during render without memoisation.
 */

/** `3s ago` / `4h ago` / `2d ago`. Falls back to a date past 30 days. */
export function relativeTime(input: Date | string | null | undefined): string {
  if (!input) return 'unknown';
  const date = typeof input === 'string' ? new Date(input) : input;
  const diff = Date.now() - date.getTime();
  if (Number.isNaN(diff)) return 'unknown';

  const seconds = Math.round(diff / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;

  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** `1234` → `1.2k`, `1250000` → `1.3M`. For pull counts and stars. */
export function compactNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const abs = Math.abs(value);
  if (abs < 1000) return String(value);
  if (abs < 1_000_000) {
    const scaled = value / 1000;
    return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1).replace(/\.0$/, '')}k`;
  }
  const scaled = value / 1_000_000;
  return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1).replace(/\.0$/, '')}M`;
}

/** `2026-09-16T…` → `Sep 16, 2026`. */
export function formatDate(input: string | Date | null | undefined): string {
  if (!input) return '—';
  const date = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** `sha256:abc123…` → `sha256:abc123`. Digests are long and never readable. */
export function shortDigest(digest: string, keep = 12): string {
  if (digest.length <= keep) return digest;
  return digest.slice(0, keep) + '…';
}

/** `1_048_576` → `1.0 MB`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exp;
  return `${exp === 0 ? value : value.toFixed(1)} ${units[exp]}`;
}

/** `Ada Lovelace` → `AL`. Used when a user has no avatar URL. */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0] ?? '')
    .join('')
    .toUpperCase()
    .slice(0, 2);
}
