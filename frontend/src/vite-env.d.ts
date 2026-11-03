/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Error tracking (lib/error-reporting.ts); off when unset. */
  readonly VITE_SENTRY_DSN?: string;
  readonly VITE_SENTRY_ENVIRONMENT?: string;
  readonly VITE_SENTRY_RELEASE?: string;
}
