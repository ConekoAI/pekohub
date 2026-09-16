/**
 * Legacy share-link redirect.
 *
 * The public peko page used to live at `/p/$owner/$principalName`;
 * the user-facing concept was renamed to "peko" and the canonical
 * URL is now `/peko/$owner/$pekoName`. Old `/p/...` links keep
 * working via this redirect (replace, so the back button skips it).
 */

import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/p/$owner/$principalName")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/peko/$owner/$pekoName",
      params: { owner: params.owner, pekoName: params.principalName },
      replace: true,
    });
  },
});
