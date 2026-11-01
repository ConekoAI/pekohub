/**
 * `/authorize` — the consent page of the hub's OAuth server.
 *
 * Peko desktop opens `api…/oauth/authorize`, which validates the request
 * and sends the browser here with a short-lived signed `request`. The
 * signed-in user allows or cancels; either way the browser goes back to
 * the app's loopback redirect.
 */

import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useAuth } from '~/hooks/useAuth';
import { api } from '~/lib/api';
import {
  ConsentDone,
  ConsentLoading,
  ConsentProblem,
  ConsentPrompt,
  ConsentShell,
  ConsentSignIn,
} from '~/components/oauth/ConsentCard';

export const Route = createFileRoute('/authorize')({
  head: () => ({ meta: [{ title: 'Sign in — PekoHub' }] }),
  component: AuthorizePage,
  validateSearch: (search: Record<string, unknown>) => ({
    request: typeof search.request === 'string' ? search.request : undefined,
    error: typeof search.error === 'string' ? search.error : undefined,
  }),
});

function AuthorizePage() {
  const { request, error } = Route.useSearch();
  return <ConsentShell>{error || !request ? <InvalidLink /> : <Consent request={request} />}</ConsentShell>;
}

function InvalidLink() {
  return (
    <ConsentProblem
      title="This sign-in link isn't valid"
      body="Start signing in again from Peko desktop. If it keeps happening, update the app."
    />
  );
}

function Consent({ request }: { request: string }) {
  const { user, isLoading: authLoading, logout } = useAuth();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<'allowed' | 'canceled' | 'failed' | null>(null);

  const details = useQuery({
    queryKey: ['oauth-request', request],
    queryFn: () => api.describeAuthorizeRequest(request),
    retry: false,
    staleTime: Infinity,
  });

  if (details.isLoading || authLoading) return <ConsentLoading label="Checking the request…" />;
  if (details.isError || !details.data) {
    return (
      <ConsentProblem
        title="This sign-in request expired"
        body="Requests last ten minutes. Start signing in again from Peko desktop."
      />
    );
  }

  const appName = details.data.client.name;
  if (outcome === 'allowed') {
    return (
      <ConsentDone
        title={`You're signed in to ${appName}`}
        body="Go back to the app to continue. You can close this tab."
      />
    );
  }
  if (outcome === 'canceled') {
    return <ConsentProblem title="Sign-in canceled" body={`${appName} was not given access. You can close this tab.`} />;
  }
  if (outcome === 'failed') {
    return (
      <ConsentProblem
        title="Something went wrong"
        body="PekoHub couldn't finish signing you in. Start again from Peko desktop."
      />
    );
  }
  if (!user) return <ConsentSignIn appName={appName} />;

  const decide = async (approve: boolean) => {
    setBusy(true);
    try {
      const { redirectTo } = await api.decideAuthorizeRequest(request, approve);
      setOutcome(approve ? 'allowed' : 'canceled');
      // The app's loopback listener picks this up and finishes sign-in.
      window.location.assign(redirectTo);
    } catch {
      setOutcome('failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ConsentPrompt
      appName={appName}
      user={user}
      busy={busy}
      onDecide={(approve) => void decide(approve)}
      onSignOut={() => void logout()}
      note="Only allow this if you just started signing in from Peko desktop on this computer."
    />
  );
}
