/**
 * Error tracking (Sentry), off unless `SENTRY_DSN` is set.
 *
 * The SDK is loaded only when configured, so an unset DSN costs nothing.
 * It runs with a short, explicit integration list: no request data, local
 * variables, or HTTP breadcrumbs, because those can carry OAuth codes,
 * tokens, and cookies. An event holds the error, its stack, and the
 * context the call site passes; call sites pass ids, never secrets.
 *
 * The process-wide `uncaughtException` / `unhandledRejection` handlers
 * live in `index.ts` (Sentry's own would keep the process alive after an
 * unhandled rejection, which changes Node's crash-and-restart behavior).
 */

type SentryModule = typeof import("@sentry/node");

let sentry: SentryModule | null = null;

export interface ErrorReportingOptions {
  dsn?: string;
  environment: string;
  release?: string;
}

/** Start reporting when a DSN is configured. Returns whether it is on. */
export async function initErrorReporting(options: ErrorReportingOptions): Promise<boolean> {
  if (!options.dsn) return false;
  const Sentry = await import("@sentry/node");
  Sentry.initWithoutDefaultIntegrations({
    dsn: options.dsn,
    environment: options.environment,
    release: options.release,
    // Belt and braces: the integrations below collect none of this anyway.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      stackFrameVariables: false,
      databaseQueryData: false,
    },
    integrations: [
      Sentry.eventFiltersIntegration(),
      Sentry.functionToStringIntegration(),
      Sentry.linkedErrorsIntegration(),
      Sentry.dedupeIntegration(),
      Sentry.contextLinesIntegration(),
      Sentry.nodeContextIntegration(),
    ],
  });
  sentry = Sentry;
  return true;
}

/** Report an unexpected error. A no-op when reporting is off. */
export function reportError(err: unknown, context?: Record<string, unknown>): void {
  if (!sentry) return;
  sentry.captureException(err, context ? { extra: context } : undefined);
}

/** Wait (at most `timeoutMs`) for queued reports to be sent, before exiting. */
export async function flushErrorReports(timeoutMs = 2000): Promise<void> {
  if (!sentry) return;
  await sentry.flush(timeoutMs);
}

/** Test-only: replace the SDK with a stub (or turn reporting off with `null`). */
export function setErrorReporterForTests(stub: Pick<SentryModule, "captureException" | "flush"> | null): void {
  sentry = stub as SentryModule | null;
}
