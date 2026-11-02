/**
 * Legacy share-link redirect.
 *
 * A peko's page is its ID, `/@alice/ada` (hub ADR-009). Share links to
 * the old `/peko/alice/ada` page are already out, so they keep working
 * (replace, so the back button skips the dead URL).
 */

import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/peko/$owner/$pekoName')({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/@{$owner}/$name',
      params: { owner: params.owner, name: params.pekoName },
      replace: true,
    });
  },
});
