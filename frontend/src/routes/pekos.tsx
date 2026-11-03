/**
 * Legacy `/pekos` redirect.
 *
 * There is no peko directory (hub ADR-009). Old links, and their query,
 * go to the seeds.
 */

import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/pekos')({
  validateSearch: (search: Record<string, unknown>) => ({
    q: typeof search.q === 'string' ? search.q : undefined,
  }),
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/seeds', search: search.q ? { q: search.q } : {}, replace: true });
  },
});
