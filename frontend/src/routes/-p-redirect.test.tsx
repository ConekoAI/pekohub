import { describe, it, expect } from 'vitest';
import { createRouter, createMemoryHistory } from '@tanstack/react-router';
import { routeTree } from '~/routeTree.gen';

/**
 * Share links already out must keep working: a peko's page is now its ID,
 * `/@owner/name` (hub ADR-009), and the older `/p/…` and `/peko/…` pages
 * redirect there in one hop (replace, so the back button skips them).
 */
describe('legacy peko share links', () => {
  for (const legacy of ['/p/alice/foo', '/peko/alice/foo']) {
    it(`${legacy} → /@alice/foo`, async () => {
      const router = createRouter({
        routeTree,
        history: createMemoryHistory({ initialEntries: [legacy] }),
      });
      await router.load();
      expect(router.state.location.pathname).toBe('/@alice/foo');
    });
  }
});
