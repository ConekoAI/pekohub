/**
 * Public peko profile + chat page (PR-C4).
 *
 * URL: `/peko/$owner/$pekoName`. Anyone with the link lands
 * here. The page renders a profile header + chat panel; an HTTP
 * cookie is minted by the backend on first visit so a returning
 * browser resumes its own chat thread.
 *
 * The OG meta tag block (PR-C6) lives in the route's `head` export
 * so link-preview unfurls (Discord, Slack, iMessage) see the
 * peko's name + description. Image unfurl is a placeholder
 * for v1 — real OG rendering is a follow-up.
 */

import { createFileRoute, notFound } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { api } from "~/lib/api";
import { ProfileHeader } from "~/components/public-chat/ProfileHeader";
import { PublicChatPanel } from "~/components/public-chat/PublicChatPanel";

export const Route = createFileRoute("/peko/$owner/$pekoName")({
  component: PublicPekoPage,
  head: ({ params }) => {
    // Title is generic until the profile loads; link previews use the
    // description from the head-loaded metadata. We default to the
    // URL slug so the unfurl isn't blank.
    const title = `${params.pekoName} — ${params.owner} on PekoHub`;
    const description = `Chat with ${params.owner}'s peko "${params.pekoName}" — a public peko on PekoHub.`;
    return {
      meta: [
        { title },
        { name: "description", content: description },
        { property: "og:type", content: "profile" },
        { property: "og:title", content: title },
        { property: "og:description", content: description },
        { property: "og:url", content: `${window.location.origin}/peko/${params.owner}/${params.pekoName}` },
        { name: "twitter:card", content: "summary_large_image" },
        { name: "twitter:title", content: title },
        { name: "twitter:description", content: description },
      ],
    };
  },
});

function PublicPekoPage() {
  const { owner, pekoName } = Route.useParams();

  const query = useQuery({
    queryKey: ["public-profile", owner, pekoName],
    queryFn: () => api.publicProfile(owner, pekoName),
    retry: false,
  });

  if (query.isLoading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-peko-600" />
      </div>
    );
  }

  if (query.isError || !query.data) {
    throw notFound();
  }

  const profile = query.data;

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 lg:px-8">
      <ProfileHeader profile={profile} />
      <div className="mt-4">
        <PublicChatPanel profile={profile} />
      </div>
    </div>
  );
}
