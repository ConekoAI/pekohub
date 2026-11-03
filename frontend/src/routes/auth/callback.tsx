import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { setAuthToken } from '~/lib/api';
import { takeSignInReturnTo } from '~/components/SignInModal';
import { Spinner } from '~/components/ui';

export const Route = createFileRoute('/auth/callback')({
  component: AuthCallbackPage,
});

function AuthCallbackPage() {
  const navigate = useNavigate();
  const search = useSearch({ from: '/auth/callback' });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = search as Record<string, unknown>;
    const token = params.token;
    const errorMsg = params.error;

    if (typeof errorMsg === 'string' && errorMsg) {
      setError(errorMsg);
      return;
    }

    if (typeof token === 'string' && token) {
      setAuthToken(token);
      const returnTo = takeSignInReturnTo();
      if (returnTo) {
        void navigate({ href: returnTo, replace: true });
      } else {
        void navigate({ to: '/dashboard', replace: true });
      }
    } else {
      setError('Authentication failed: no token received');
    }
  }, [search, navigate]);

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
