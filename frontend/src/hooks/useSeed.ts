import { useQuery } from '@tanstack/react-query';
import { api } from '~/lib/api';

/**
 * Seeds: the DNA a peko grows from (runtime ADR-060) — a stripped
 * `principal.toml`, named `<owner>/<name>` like a peko's share path.
 */
export function useSeed(owner: string, name: string) {
  return useQuery({
    queryKey: ['seed', owner, name],
    queryFn: () => api.getSeed(owner, name),
    enabled: Boolean(owner) && Boolean(name),
    retry: false,
  });
}

/** Newest seeds first — the registry's default listing; `owner` for one person's. */
export function useSeedList(page = 1, perPage = 24, owner?: string) {
  return useQuery({
    queryKey: ['seeds', page, perPage, owner ?? null],
    queryFn: () => api.listSeeds({ page, perPage, owner }),
    staleTime: 1000 * 60,
  });
}
