/**
 * Legacy `/search` redirect.
 *
 * The website searches seeds only, on `/seeds`. Finding a person or a peko
 * by its ID is the desktop's job — that is where people talk — and the
 * desktop asks the API (`GET /v1/search`, hub ADR-009 D4) directly.
 */

import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/search')({
  validateSearch: (search: Record<string, unknown>) => ({
    q: typeof search.q === 'string' && search.q.trim() ? search.q.trim() : undefined,
  }),
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/seeds', search: search.q ? { q: search.q } : {}, replace: true });
  },
});
