/**
 * Legacy `/templates/...` redirect.
 *
 * The user-facing surface renamed "templates" → "seeds" (runtime
 * ADR-060): a seed is DNA that grows one peko with a freshly minted
 * identity, which a template (a die that stamps matching copies)
 * never described correctly.
 *
 * `/templates` was a public URL, so it is answered with a `301`-style
 * `replace` redirect rather than removed: existing bookmarks and
 * inbound links keep working. The splat matches zero segments, so
 * this single route covers both bare `/templates` and
 * `/templates/<repo>`.
 *
 * The target is built as a raw href on purpose: these are legacy
 * bookmarks, not an in-app navigation, and a string path keeps the
 * redirect independent of the generated route ids.
 */

import { createFileRoute, redirect } from '@tanstack/react-router';
import { hubRefPath, parseHubRef } from '@pekohub/shared';

export const Route = createFileRoute('/templates_/$')({
  beforeLoad: ({ params }) => {
    // A seed's page is its ID (hub ADR-009); anything else, the directory.
    const ref = parseHubRef(`/seeds/${params._splat ?? ''}`);
    throw redirect({ href: ref?.kind === 'seed' ? hubRefPath(ref) : '/search', replace: true });
  },
});
