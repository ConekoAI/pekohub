/**
 * Legacy `/pekos` redirect.
 *
 * There is no peko directory: a public peko is found only by its exact
 * ID, `@alice/ada` (hub ADR-009). Old links, and their query, go to the
 * one search.
 */

import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/pekos')({
  validateSearch: (search: Record<string, unknown>) => ({
    q: typeof search.q === 'string' ? search.q : undefined,
  }),
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/search', search: { q: search.q }, replace: true });
  },
});
