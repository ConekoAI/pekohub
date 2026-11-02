/**
 * Link previews for share links, used by the Cloudflare Pages Functions in
 * `functions/` (not by the app).
 *
 * The website is a client-rendered app, so a crawler fetching a page —
 * `/@alice` (a person), `/@alice/ada` (a peko), `/alice/ada` (a seed);
 * hub ADR-009 — sees only the generic `index.html`. These functions look the page up on the API and write its
 * own title, description, OpenGraph and Twitter tags, and canonical URL
 * into the page before it is served. Everything else is untouched.
 */

export interface Preview {
  title: string;
  description: string;
  url: string;
  /** `profile` for a person or peko, `website` for a seed. */
  type: 'profile' | 'website';
}

export interface Env {
  /** The API origin; defaults to the official one. */
  PEKOHUB_API?: string;
}

export const DEFAULT_API = 'https://api.pekohub.ai';

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** Collapse whitespace and keep a description to one preview line. */
export function clip(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** The tags appended to `<head>` (the `<title>` is replaced separately). */
export function headTags(preview: Preview): string {
  const title = escapeHtml(preview.title);
  const description = escapeHtml(preview.description);
  const url = escapeHtml(preview.url);
  return [
    `<link rel="canonical" href="${url}" />`,
    `<meta property="og:site_name" content="PekoHub" />`,
    `<meta property="og:type" content="${preview.type}" />`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${description}" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta name="twitter:card" content="summary" />`,
    `<meta name="twitter:title" content="${title}" />`,
    `<meta name="twitter:description" content="${description}" />`,
  ].join('\n    ');
}

/** A peko's preview from `GET /v1/public/pekos/:owner/:name`. */
export function pekoPreview(profile: unknown, owner: string, name: string, url: string): Preview | null {
  const live = (profile as { liveInstance?: Record<string, unknown> } | null)?.liveInstance;
  if (!live) return null;
  const shown = typeof live.publicName === 'string' && live.publicName ? live.publicName : name;
  const ownerName =
    typeof (live.owner as { name?: unknown } | undefined)?.name === 'string'
      ? (live.owner as { name: string }).name
      : owner;
  const description =
    typeof live.description === 'string' && live.description.trim()
      ? clip(live.description)
      : `${ownerName}'s peko on PekoHub. Open it in Peko to message it.`;
  return { title: `${shown} — ${ownerName}'s peko on PekoHub`, description, url, type: 'profile' };
}

/** A person's preview from `GET /v1/people/:handle`. Their pekos are never named. */
export function personPreview(person: unknown, handle: string, url: string): Preview | null {
  const p = person as Record<string, unknown> | null;
  if (!p || typeof p.handle !== 'string') return null;
  const shown = typeof p.displayName === 'string' && p.displayName ? p.displayName : `@${handle}`;
  return {
    title: `${shown} (@${p.handle}) on PekoHub`,
    description: `${shown} on PekoHub, and the seeds they publish.`,
    url,
    type: 'profile',
  };
}

/** A seed's preview from `GET /v1/seeds/:owner/:name`. */
export function seedPreview(seed: unknown, owner: string, name: string, url: string): Preview | null {
  const s = seed as Record<string, unknown> | null;
  if (!s || typeof s.name !== 'string') return null;
  const shown = typeof s.displayName === 'string' && s.displayName ? s.displayName : name;
  const description =
    typeof s.description === 'string' && s.description.trim()
      ? clip(s.description)
      : `A seed by ${owner}: grow your own peko from it with Peko.`;
  return { title: `${shown} — a seed by ${owner} on PekoHub`, description, url, type: 'website' };
}

// Minimal shapes of the Pages runtime, so this file needs no extra packages.
interface ElementLike {
  setInnerContent(content: string): void;
  append(content: string, options: { html: boolean }): void;
}
declare const HTMLRewriter: {
  new (): {
    on(selector: string, handlers: { element(el: ElementLike): void }): {
      on(selector: string, handlers: { element(el: ElementLike): void }): { transform(r: Response): Response };
      transform(r: Response): Response;
    };
  };
};

export interface Context {
  request: Request;
  env: Env;
  params: Record<string, string | string[]>;
  next(): Promise<Response>;
}

/** A route param as written in the URL (`%40alice` is `@alice`). */
function param(value: string | string[] | undefined): string {
  const raw = String(value ?? '');
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Serve the app with `lookup`'s preview written in. Any failure — the API
 * down, the page not found, a non-HTML asset — serves the page unchanged.
 */
export async function withPreview(
  context: Context,
  lookup: (api: string, owner: string, name: string, url: string) => Promise<Preview | null>,
): Promise<Response> {
  const page = await context.next();
  if (!(page.headers.get('content-type') ?? '').includes('text/html')) return page;
  const owner = param(context.params.owner);
  const name = param(context.params.name);
  const url = new URL(context.request.url);
  url.search = '';
  let preview: Preview | null = null;
  try {
    preview = await lookup((context.env.PEKOHUB_API ?? DEFAULT_API).replace(/\/+$/, ''), owner, name, url.toString());
  } catch {
    preview = null;
  }
  if (!preview) return page;
  const description = escapeHtml(preview.description);
  return new HTMLRewriter()
    .on('title', { element: (el) => el.setInnerContent(preview!.title) })
    .on('head', {
      element: (el) => {
        el.append(`    ${headTags(preview!)}\n`, { html: true });
        el.append(`    <meta name="description" content="${description}" />\n`, { html: true });
      },
    })
    .transform(page);
}

/**
 * The preview for a two-segment page: `/@alice/ada` is a peko, `/alice/ada`
 * (or `/alice/ada@1.2.0`) a seed. Pages routes both to one function.
 */
export async function pagePreview(api: string, first: string, second: string, url: string): Promise<Preview | null> {
  const enc = encodeURIComponent;
  if (first.startsWith('@')) {
    const owner = first.slice(1).toLowerCase();
    return pekoPreview(await fetchJson(`${api}/v1/public/pekos/${enc(owner)}/${enc(second)}`), owner, second, url);
  }
  const name = second.split('@')[0];
  return seedPreview(await fetchJson(`${api}/v1/seeds/${enc(first)}/${enc(name)}`), first, name, url);
}

export async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { accept: 'application/json' }, cf: { cacheTtl: 300 } } as RequestInit);
  if (!response.ok) return null;
  return response.json();
}
