/**
 * Legacy `/seeds/<owner>/<name>` redirect.
 *
 * A seed's page is its ID, `/alice/ada` (hub ADR-009); share links to
 * the old path are already out, so they keep working (replace, so the
 * back button skips the dead URL). A splat inside `seeds/`, so bare
 * `/seeds` stays the directory.
 */

import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { hubRefPath, parseHubRef } from '@pekohub/shared';

export const Route = createFileRoute('/seeds/$')({
  beforeLoad: ({ params }) => {
    const ref = parseHubRef(`/seeds/${params._splat ?? ''}`);
    if (ref?.kind !== 'seed') throw notFound();
    throw redirect({ href: hubRefPath(ref), replace: true });
  },
});
