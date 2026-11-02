/**
 * PekoHub IDs (hub ADR-009).
 *
 *   person  `@alice`              page `/@alice`
 *   peko    `@alice/ada`          page `/@alice/ada`
 *   seed    `alice/ada`           page `/alice/ada`
 *           `alice/ada@1.2.0`     page `/alice/ada@1.2.0`
 *
 * `@` marks someone you can talk to; a bare `owner/name` is something you
 * download. People and pekos are found only by their exact ID; seeds are
 * also searchable.
 */

export type HubRef =
  | { kind: 'person'; handle: string }
  | { kind: 'peko'; owner: string; name: string }
  | { kind: 'seed'; owner: string; name: string; version?: string };

/** An account handle (`users.namespace`). */
const HANDLE = /^[a-z0-9][a-z0-9_-]{0,127}$/;
/** A peko's or seed's name (the runtime's `validate_agent_name`). */
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** A seed's owner: a handle, plus the spellings older seeds were published under. */
const SEED_OWNER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const VERSION = /^[0-9A-Za-z.-]{1,64}$/;

/** The ID as people write it: `@alice`, `@alice/ada`, `alice/ada[@1.2.0]`. */
export function formatHubRef(ref: HubRef): string {
  switch (ref.kind) {
    case 'person':
      return `@${ref.handle}`;
    case 'peko':
      return `@${ref.owner}/${ref.name}`;
    case 'seed':
      return `${ref.owner}/${ref.name}${ref.version ? `@${ref.version}` : ''}`;
  }
}

/** The website path of an ID: the ID itself after a `/`. */
export function hubRefPath(ref: HubRef): string {
  return `/${formatHubRef(ref)}`;
}

function personRef(handle: string): HubRef | null {
  const lower = handle.toLowerCase();
  return HANDLE.test(lower) ? { kind: 'person', handle: lower } : null;
}

function pekoRef(owner: string, name: string): HubRef | null {
  const lower = owner.toLowerCase();
  return HANDLE.test(lower) && NAME.test(name) && !name.endsWith('-')
    ? { kind: 'peko', owner: lower, name }
    : null;
}

function seedRef(owner: string, nameAndVersion: string): HubRef | null {
  const at = nameAndVersion.indexOf('@');
  const name = at < 0 ? nameAndVersion : nameAndVersion.slice(0, at);
  const version = at < 0 ? undefined : nameAndVersion.slice(at + 1);
  if (!SEED_OWNER.test(owner) || !NAME.test(name)) return null;
  if (version !== undefined && !VERSION.test(version)) return null;
  return version ? { kind: 'seed', owner, name, version } : { kind: 'seed', owner, name };
}

/** Path segments → an ID, accepting the retired `/peko/…`, `/p/…`, `/seeds/…` pages. */
function fromSegments(segments: string[]): HubRef | null {
  const [first, second, third] = segments;
  if (segments.length === 1 && first.startsWith('@')) return personRef(first.slice(1));
  if (segments.length === 2 && first.startsWith('@')) return pekoRef(first.slice(1), second);
  if (segments.length === 2) return seedRef(first, second);
  if (segments.length === 3 && (first === 'peko' || first === 'p')) return pekoRef(second, third);
  if (segments.length === 3 && (first === 'seeds' || first === 'templates' || first === 'bundles')) {
    return seedRef(second, third);
  }
  return null;
}

function segmentsOf(path: string): string[] | null {
  try {
    return path
      .split('/')
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
}

/**
 * Read an ID from what someone typed or pasted: the ID itself, or a link to
 * its page (`https://pekohub.ai/@alice/ada`, also without the scheme, and
 * the old `/peko/alice/ada` and `/seeds/alice/ada` links). `null` for
 * anything else — free text.
 */
export function parseHubRef(input: string): HubRef | null {
  const text = input.trim();
  if (!text || /\s/.test(text)) return null;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return null;
    }
    const segments = segmentsOf(url.pathname);
    return segments ? fromSegments(segments) : null;
  }

  const segments = segmentsOf(text.replace(/[?#].*$/, ''));
  if (!segments || segments.length === 0) return null;
  const direct = fromSegments(segments);
  if (direct) return direct;
  // `pekohub.ai/@alice/ada`: a link without its scheme. No ID begins with
  // a dotted segment followed by more path, so drop it and try again.
  if (segments.length > 1 && segments[0].includes('.')) return fromSegments(segments.slice(1));
  return null;
}
