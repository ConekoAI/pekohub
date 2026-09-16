import { useQuery } from '@tanstack/react-query';
import { api, type TemplateVersionsResponse } from '~/lib/api';

/**
 * Template detail + version history.
 *
 * A "template" is what the registry actually holds after the pivot:
 * DNA, not an existence (runtime ADR-056 D6). The wire path is still
 * `/v1/bundles/...` because the hub's machine vocabulary keeps the
 * pre-pivot name — only the user-facing term moved to "template".
 */
export function useTemplate(namespace: string, name: string) {
  return useQuery({
    queryKey: ['template', namespace, name],
    queryFn: () => api.getBundle(namespace, name),
    enabled: Boolean(namespace) && Boolean(name),
  });
}

export function useTemplateVersions(namespace: string, name: string, enabled = true) {
  return useQuery<TemplateVersionsResponse>({
    queryKey: ['template', namespace, name, 'versions'],
    queryFn: () => api.getBundleVersions(namespace, name),
    enabled: Boolean(namespace) && Boolean(name) && enabled,
  });
}

/**
 * OCI catalog — the registry's real contents, used as the template
 * directory listing (no derived search index involved).
 */
export function useTemplateCatalog() {
  return useQuery({
    queryKey: ['catalog'],
    queryFn: () => api.getCatalog(),
    staleTime: 1000 * 60 * 5,
  });
}
