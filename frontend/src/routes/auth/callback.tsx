import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { AlertCircle, ArrowLeft } from 'lucide-react';
import { setAuthToken } from '~/lib/api';
import { Backdrop, Spinner } from '~/components/ui';

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
      void navigate({ to: '/dashboard', replace: true });
    } else {
      setError('Authentication failed: no token received');
    }
  }, [search, navigate]);

  return (
    <div className="relative isolate">
      <Backdrop />
      <div className="mx-auto flex min-h-[70vh] max-w-md flex-col items-center justify-center px-4 text-center">
        {error ? (
          <div className="panel w-full animate-fade-up p-8">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-rose-400/25 bg-rose-500/[0.08]">
              <AlertCircle className="h-6 w-6 text-rose-400" />
            </div>
            <h1 className="display mt-5 text-xl">Sign-in failed</h1>
            <p className="mt-2 break-words font-mono text-2xs leading-relaxed text-rose-200/70">
              {error}
            </p>
            <button onClick={() => void navigate({ to: '/' })} className="btn-primary mt-6">
              <ArrowLeft className="h-4 w-4" />
              Back home
            </button>
          </div>
        ) : (
          <div className="panel w-full animate-fade-up p-8">
            <Spinner className="mx-auto h-6 w-6" />
            <h1 className="display mt-5 text-xl">Signing you in…</h1>
            <p className="lede mt-2">Exchanging the OAuth handshake for a session.</p>
          </div>
        )}
      </div>
    </div>
  );
}
