/**
 * Security headers for the website's pages, added at the edge by
 * `functions/_middleware.ts` (a `_headers` file doesn't reach responses
 * that pass through Pages Functions, and every page does).
 *
 * The page loads its own scripts only, fonts from Google, avatars from the
 * account's provider, and talks to the API origin (and, when error tracking
 * is configured, to its ingest host). Nothing may frame it: the sign-in
 * consent page (`/authorize`) is a clickjacking target.
 */

/** The origin error reports go to, for an `https` Sentry DSN; anything else, none. */
export function reportOrigin(dsn: string | undefined): string | null {
  if (!dsn) return null;
  try {
    const url = new URL(dsn);
    return url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

export function contentSecurityPolicy(apiOrigin: string, sentryDsn?: string): string {
  const api = apiOrigin.replace(/\/+$/, '');
  const reports = reportOrigin(sentryDsn);
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https:",
    `connect-src 'self' ${api}${reports ? ` ${reports}` : ''}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function securityHeaders(apiOrigin: string, sentryDsn?: string): Record<string, string> {
  return {
    'Content-Security-Policy': contentSecurityPolicy(apiOrigin, sentryDsn),
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  };
}

/** `page` with the headers set, when it is an HTML page; anything else as is. */
export function withSecurityHeaders(page: Response, apiOrigin: string, sentryDsn?: string): Response {
  if (!(page.headers.get('content-type') ?? '').includes('text/html')) return page;
  const secured = new Response(page.body, page);
  for (const [name, value] of Object.entries(securityHeaders(apiOrigin, sentryDsn))) {
    secured.headers.set(name, value);
  }
  return secured;
}
