import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { setAuthToken } from '~/lib/api';
import { Loader2, AlertCircle } from 'lucide-react';

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
      navigate({ to: '/' });
    } else {
      setError('Authentication failed: no token received');
    }
  }, [search, navigate]);

  if (error) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center text-gray-600">
        <AlertCircle className="h-10 w-10 text-red-500" />
        <p className="mt-4 text-sm font-medium text-red-600">{error}</p>
        <button
          onClick={() => navigate({ to: '/' })}
          className="mt-4 btn-primary text-sm"
        >
          Go Home
        </button>
      </div>
    );
  }

  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center text-gray-600">
      <Loader2 className="h-8 w-8 animate-spin text-peko-600" />
      <p className="mt-4 text-sm font-medium">Signing you in...</p>
    </div>
  );
}
