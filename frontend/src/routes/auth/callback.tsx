import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect } from 'react';
import { setAuthToken } from '~/lib/api';
import { Loader2 } from 'lucide-react';

export const Route = createFileRoute('/auth/callback')({
  component: AuthCallbackPage,
});

function AuthCallbackPage() {
  const navigate = useNavigate();
  const search = useSearch({ from: '/auth/callback' });

  useEffect(() => {
    const token = (search as Record<string, unknown>).token;
    if (typeof token === 'string' && token) {
      setAuthToken(token);
    }
    navigate({ to: '/' });
  }, [search, navigate]);

  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center text-gray-600">
      <Loader2 className="h-8 w-8 animate-spin text-peko-600" />
      <p className="mt-4 text-sm font-medium">Signing you in...</p>
    </div>
  );
}
