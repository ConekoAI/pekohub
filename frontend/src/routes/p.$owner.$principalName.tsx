/**
 * Public principal profile + chat page (PR-C4).
 *
 * URL: `/p/$owner/$principalName`. Anyone with the link lands
 * here. The page renders a profile header + chat panel; an HTTP
 * cookie is minted by the backend on first visit so a returning
 * browser resumes its own chat thread.
 *
 * The OG meta tag block (PR-C6) lives in the route's `head` export
 * so link-preview unfurls (Discord, Slack, iMessage) see the
 * principal's name + description. Image unfurl is a placeholder
 * for v1 — real OG rendering is a follow-up.
 */

import { createFileRoute, notFound } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { api } from "~/lib/api";
import { ProfileHeader } from "~/components/public-chat/ProfileHeader";
import { PublicChatPanel } from "~/components/public-chat/PublicChatPanel";

export const Route = createFileRoute("/p/$owner/$principalName")({
  component: PublicPrincipalPage,
  head: ({ params }) => {
    // Title is generic until the profile loads; link previews use the
    // description from the head-loaded metadata. We default to the
    // URL slug so the unfurl isn't blank.
    const title = `${params.principalName} — ${params.owner} on PekoHub`;
    const description = `Chat with ${params.owner}'s principal "${params.principalName}" — a public PekoHub agent.`;
    return {
      meta: [
        { title },
        { name: "description", content: description },
        { property: "og:type", content: "profile" },
        { property: "og:title", content: title },
        { property: "og:description", content: description },
        { property: "og:url", content: `${window.location.origin}/p/${params.owner}/${params.principalName}` },
        { name: "twitter:card", content: "summary_large_image" },
        { name: "twitter:title", content: title },
        { name: "twitter:description", content: description },
      ],
    };
  },
});

function PublicPrincipalPage() {
  const { owner, principalName } = Route.useParams();

  const query = useQuery({
    queryKey: ["public-profile", owner, principalName],
    queryFn: () => api.publicProfile(owner, principalName),
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