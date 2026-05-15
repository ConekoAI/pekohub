import { useQuery } from '@tanstack/react-query';
import { api } from '~/lib/api';

export function useBundle(namespace: string, name: string) {
  return useQuery({
    queryKey: ['bundle', namespace, name],
    queryFn: () => api.getBundle(namespace, name),
    enabled: !!namespace && !!name,
  });
}
