import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, setAuthToken } from '~/lib/api';
import { takeSignInReturnTo } from '~/components/SignInModal';
import { Spinner } from '~/components/ui';

export const Route = createFileRoute('/auth/callback')({
  component: AuthCallbackPage,
});

function AuthCallbackPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const search = useSearch({ from: '/auth/callback' });
  const [error, setError] = useState<string | null>(null);
  // Once per visit: the return-to path is consumed on read, and StrictMode
  // runs effects twice in development.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const params = search as Record<string, unknown>;
    // The API puts the token in the fragment (`#token=…`), which is never
    // sent to a server; take it out of the address bar and history at once.
    const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
    if (window.location.hash) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
    const errorMsg = params.error;

    if (typeof errorMsg === 'string' && errorMsg) {
      setError(errorMsg);
      return;
    }

    if (token) {
      setAuthToken(token);
      const returnTo = takeSignInReturnTo();
      // Load the user before leaving, so the next page opens signed in
      // rather than flashing "Sign in". `staleTime: 0`: the header already
      // cached "signed out" (no token when the page loaded), and the app's
      // 5-minute freshness would otherwise return that without asking.
      // A handle no one has confirmed yet (first sign-in) is kept or
      // changed on `/welcome` first, then the person goes where they were.
      void queryClient
        .fetchQuery({ queryKey: ['auth', 'me'], queryFn: () => api.getMe(), staleTime: 0 })
        .catch(() => null)
        .then((me) =>
          me && me.handleChosen === false
            ? navigate({ to: '/welcome', search: { next: returnTo ?? undefined }, replace: true })
            : returnTo
              ? navigate({ href: returnTo, replace: true })
              : navigate({ to: '/dashboard', replace: true }),
        );
    } else {
      setError('Authentication failed: no token received');
    }
  }, [search, navigate, queryClient]);

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-sm flex-col items-center justify-center px-5 text-center">
      {error ? (
        <div className="animate-fade-up">
          <h1 className="h-page">Sign-in failed</h1>
          <p className="mt-3 break-words font-mono text-xs text-slate-500">{error}</p>
          <button onClick={() => void navigate({ to: '/' })} className="btn-secondary mt-8">
            Back home
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2.5 text-sm text-slate-400">
          <Spinner className="h-4 w-4" />
          Signing you in…
        </div>
      )}
    </div>
  );
}
