import { useQuery } from '@tanstack/react-query';
import { api } from '~/lib/api';
import type { SearchQuery } from '@pekohub/shared';

export function useSearch(query: SearchQuery) {
  return useQuery({
    queryKey: ['search', query],
    queryFn: () => api.search(query),
    enabled: query.q.length > 0,
  });
}
