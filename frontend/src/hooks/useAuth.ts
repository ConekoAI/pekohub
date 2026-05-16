import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '~/lib/api';

export function useAuth() {
  const queryClient = useQueryClient();

  const { data: user, isLoading } = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () => api.getMe(),
    retry: false,
    staleTime: 5 * 60 * 1000,
  });

  const isAuthenticated = !!user;

  const logout = async () => {
    await api.logout();
    queryClient.removeQueries({ queryKey: ['auth'] });
    queryClient.invalidateQueries();
  };

  return { user, isLoading, isAuthenticated, logout };
}
