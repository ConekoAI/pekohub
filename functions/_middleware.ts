import { DEFAULT_API, type Context } from '../frontend/src/lib/preview';
import { withSecurityHeaders } from '../frontend/src/lib/security-headers';

/** Every page the website serves carries its security headers (CSP, HSTS, no framing). */
export const onRequest = async (context: Context) =>
  withSecurityHeaders(
    await context.next(),
    context.env.PEKOHUB_API ?? DEFAULT_API,
    context.env.VITE_SENTRY_DSN,
  );
