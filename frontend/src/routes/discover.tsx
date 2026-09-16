/**
 * Legacy `/discover` redirect.
 *
 * The public directory was named after the verb; it now lives at
 * `/pekos` after the noun, matching ADR-059's user-facing vocabulary.
 */

import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/discover')({
  beforeLoad: () => {
    throw redirect({ to: '/pekos', replace: true });
  },
});
