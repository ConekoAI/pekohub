/**
 * Legacy `/discover` redirect.
 *
 * The public peko directory is gone (hub ADR-009). Old links go to the
 * seed search.
 */

import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/discover')({
  beforeLoad: () => {
    throw redirect({ to: '/search', search: { q: undefined }, replace: true });
  },
});
