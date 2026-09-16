/**
 * Legacy `/search` redirect.
 *
 * There is no longer a separate search page: the peko directory owns
 * free-text search (`/pekos?q=`), and the registry has its own filtered
 * search at `/templates?q=`. Old `/search?q=…` links fold into the
 * directory, which is where a general query belongs.
 */

import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/search')({
  validateSearch: (search: Record<string, unknown>) => ({
    q: typeof search.q === 'string' ? search.q : undefined,
  }),
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/pekos', search: { q: search.q }, replace: true });
  },
});
