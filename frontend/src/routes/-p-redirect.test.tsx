import { describe, it, expect } from 'vitest';
import { createRouter, createMemoryHistory } from '@tanstack/react-router';
import { routeTree } from '~/routeTree.gen';

/**
 * Legacy share links at `/p/:owner/:name` must keep working after the
 * public page moved to `/peko/:owner/:name`. The legacy route throws
 * a `redirect` from `beforeLoad` (replace, so the back button skips
 * the legacy URL).
 */
describe('legacy /p/:owner/:name share links', () => {
  it('redirects to /peko/:owner/:name', async () => {
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ['/p/alice/foo'] }),
    });

    await router.load();

    expect(router.state.location.pathname).toBe('/peko/alice/foo');
  });
});
