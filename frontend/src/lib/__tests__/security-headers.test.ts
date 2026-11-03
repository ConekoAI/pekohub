import { describe, it, expect } from 'vitest';
import { contentSecurityPolicy, reportOrigin, withSecurityHeaders } from '~/lib/security-headers';

describe('website security headers (Pages middleware)', () => {
  it('lets the page reach its API and nothing frame it', () => {
    const csp = contentSecurityPolicy('https://api.pekohub.ai/');
    expect(csp).toContain("connect-src 'self' https://api.pekohub.ai;");
    expect(csp).toContain("script-src 'self';");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('secures HTML pages and leaves other responses alone', async () => {
    const page = withSecurityHeaders(
      new Response('<!doctype html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }),
      'https://pekohub-staging.fly.dev',
    );
    expect(page.headers.get('content-security-policy')).toContain('https://pekohub-staging.fly.dev');
    expect(page.headers.get('strict-transport-security')).toMatch(/^max-age=/);
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    expect(await page.text()).toBe('<!doctype html>');

    const json = new Response('{}', { headers: { 'content-type': 'application/json' } });
    expect(withSecurityHeaders(json, 'https://api.pekohub.ai')).toBe(json);
  });

  it('lets the page reach the error-tracking host only when one is configured', () => {
    const dsn = 'https://abc123@o42.ingest.us.sentry.io/7';
    expect(reportOrigin(dsn)).toBe('https://o42.ingest.us.sentry.io');
    expect(contentSecurityPolicy('https://api.pekohub.ai', dsn)).toContain(
      "connect-src 'self' https://api.pekohub.ai https://o42.ingest.us.sentry.io;",
    );
    expect(contentSecurityPolicy('https://api.pekohub.ai')).toContain("connect-src 'self' https://api.pekohub.ai;");

    // Nothing that isn't an https URL gets into the policy.
    expect(reportOrigin('http://abc@sentry.example/1')).toBeNull();
    expect(reportOrigin("https://x.example; script-src 'unsafe-inline'")).toBeNull();
    expect(reportOrigin('not a url')).toBeNull();
    expect(reportOrigin('')).toBeNull();
  });
});
