/**
 * Legacy `/discover` redirect.
 *
 * The public peko directory is gone (hub ADR-009). Old links go to the
 * seeds.
 */

import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/discover')({
  beforeLoad: () => {
    throw redirect({ to: '/seeds', search: {}, replace: true });
  },
});
