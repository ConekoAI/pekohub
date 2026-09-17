import { useQuery } from '@tanstack/react-query';
import { api, type SeedVersionsResponse } from '~/lib/api';

/**
 * Seed detail + version history.
 *
 * A "seed" is what the registry actually holds after the pivot: DNA,
 * not an existence (runtime ADR-056 D6). It is a seed rather than a
 * template because `peko create` strips identity and mints a fresh
 * one — the peko that grows from a seed is never a copy of its
 * source (runtime ADR-060).
 *
 * The wire path is still `/v1/bundles/...` and the repo lane is still
 * `peko/principals/<name>`: the hub's machine vocabulary keeps the
 * pre-pivot spelling. Only the user-facing term moved to "seed".
 */
export function useSeed(namespace: string, name: string) {
  return useQuery({
    queryKey: ['seed', namespace, name],
    queryFn: () => api.getBundle(namespace, name),
    enabled: Boolean(namespace) && Boolean(name),
  });
}

export function useSeedVersions(namespace: string, name: string, enabled = true) {
  return useQuery<SeedVersionsResponse>({
    queryKey: ['seed', namespace, name, 'versions'],
    queryFn: () => api.getBundleVersions(namespace, name),
    enabled: Boolean(namespace) && Boolean(name) && enabled,
  });
}

/**
 * OCI catalog — the registry's real contents, used as the seed
 * directory listing (no derived search index involved).
 */
export function useSeedCatalog() {
  return useQuery({
    queryKey: ['catalog'],
    queryFn: () => api.getCatalog(),
    staleTime: 1000 * 60 * 5,
  });
}
