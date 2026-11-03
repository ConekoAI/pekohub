/**
 * Security headers for the website's pages, added at the edge by
 * `functions/_middleware.ts` (a `_headers` file doesn't reach responses
 * that pass through Pages Functions, and every page does).
 *
 * The page loads its own scripts only, fonts from Google, avatars from the
 * account's provider, and talks to the API origin. Nothing may frame it:
 * the sign-in consent page (`/authorize`) is a clickjacking target.
 */

export function contentSecurityPolicy(apiOrigin: string): string {
  const api = apiOrigin.replace(/\/+$/, '');
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https:",
    `connect-src 'self' ${api}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function securityHeaders(apiOrigin: string): Record<string, string> {
  return {
    'Content-Security-Policy': contentSecurityPolicy(apiOrigin),
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  };
}

/** `page` with the headers set, when it is an HTML page; anything else as is. */
export function withSecurityHeaders(page: Response, apiOrigin: string): Response {
  if (!(page.headers.get('content-type') ?? '').includes('text/html')) return page;
  const secured = new Response(page.body, page);
  for (const [name, value] of Object.entries(securityHeaders(apiOrigin))) {
    secured.headers.set(name, value);
  }
  return secured;
}
