/**
 * Legacy `/bundles/...` redirect.
 *
 * The registry's user-facing surface renamed "bundles" → "templates"
 * when the hub became template-only (pekohub ADR-005 §2 / runtime
 * ADR-056 D6), and then "templates" → "seeds" (runtime ADR-060).
 * Both hops resolve in one step to the current surface. Old links
 * keep working via a `replace` redirect so the back button skips the
 * dead URL.
 *
 * The target is built as a raw href on purpose: these are legacy
 * bookmarks, not an in-app navigation, and a string path keeps the
 * redirect independent of the generated route ids.
 */

import { createFileRoute, redirect } from '@tanstack/react-router';
import { hubRefPath, parseHubRef } from '@pekohub/shared';

export const Route = createFileRoute('/bundles_/$')({
  beforeLoad: ({ params }) => {
    // A seed's page is its ID (hub ADR-009); anything else, the directory.
    const ref = parseHubRef(`/seeds/${params._splat ?? ''}`);
    throw redirect({ href: ref?.kind === 'seed' ? hubRefPath(ref) : '/search', replace: true });
  },
});
