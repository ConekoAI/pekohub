/**
 * Legacy share-link redirect.
 *
 * The public peko page lived at `/p/$owner/$principalName`, then at
 * `/peko/$owner/$pekoName`; it is now the peko's ID, `/@alice/ada`
 * (hub ADR-009). Old links keep working in one hop (replace, so the
 * back button skips it).
 */

import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/p/$owner/$principalName")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/@{$owner}/$name",
      params: { owner: params.owner, name: params.principalName },
      replace: true,
    });
  },
});
