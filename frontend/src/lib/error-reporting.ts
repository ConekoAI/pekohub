/**
 * Website error tracking (Sentry), off unless `VITE_SENTRY_DSN` is set at
 * build time. The SDK is a separate chunk, fetched only when configured.
 *
 * The Pages middleware allows the DSN's host in the page's CSP
 * (`connect-src`) from the same variable, so set `VITE_SENTRY_DSN` as a
 * Pages environment variable: builds and Functions both read it.
 *
 * Query strings are dropped from every URL an event carries (the page, its
 * navigations and requests): sign-in and device pages hold codes there.
 */
import { isApiError } from './api';
import { reportOrigin } from './security-headers';

let captureException: ((error: unknown) => void) | null = null;

/** `url` without its query string and fragment. */
export function withoutQuery(url: string): string {
  return url.split(/[?#]/, 1)[0];
}

export async function initErrorReporting(): Promise<void> {
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!reportOrigin(dsn)) return;
  // Destructured, so the bundler keeps only what's used.
  const { init, captureException: capture } = await import('@sentry/react');
  init({
    dsn,
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT ?? import.meta.env.MODE,
    release: import.meta.env.VITE_SENTRY_RELEASE,
    dataCollection: { userInfo: false, cookies: false, urlQueryParams: false },
    beforeSend(event) {
      if (event.request?.url) event.request.url = withoutQuery(event.request.url);
      if (event.request) delete event.request.query_string;
      return event;
    },
    beforeBreadcrumb(crumb) {
      const data = crumb.data;
      if (data) {
        for (const key of ['url', 'from', 'to']) {
          if (typeof data[key] === 'string') data[key] = withoutQuery(data[key] as string);
        }
      }
      return crumb;
    },
  });
  captureException = (error) => capture(error);
}

/**
 * Report an error a route showed instead of its page. An API refusal
 * (4xx) is the API's answer, not a website fault, so it isn't sent.
 */
export function reportError(error: unknown): void {
  if (!captureException) return;
  if (isApiError(error) && error.status < 500) return;
  captureException(error);
}
