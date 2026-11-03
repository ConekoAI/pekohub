import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, clearAuthToken, getAuthToken } from '~/lib/api';

/**
 * The signed-in user. Without a saved token the answer is known at once
 * (signed out): the query starts settled at `null` and makes no request,
 * so the header never waits on the network to show "Sign in". Sign-in
 * (`/auth/callback`) invalidates `['auth']` to fetch the user.
 */
export function useAuth() {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () => api.getMe(),
    initialData: () => (getAuthToken() ? undefined : null),
    retry: false,
    staleTime: 5 * 60 * 1000,
  });

  const user = data ?? undefined;
  const isAuthenticated = !!user;

  const logout = async () => {
    try {
      await api.logout();
    } finally {
      clearAuthToken();
      queryClient.removeQueries({ queryKey: ['auth'] });
      queryClient.invalidateQueries();
    }
  };

  return { user, isLoading, isAuthenticated, logout };
}
