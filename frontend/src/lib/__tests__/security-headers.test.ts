import { describe, it, expect } from 'vitest';
import { contentSecurityPolicy, withSecurityHeaders } from '~/lib/security-headers';

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
});
