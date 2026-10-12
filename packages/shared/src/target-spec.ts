import { z } from 'zod';

export const PrincipalName = z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/).refine(s => !s.endsWith('-'));
export const TargetSpecKind = ['by-hub-id', 'by-handle'] as const;
export type TargetSpecKind = typeof TargetSpecKind[number];
export const RemoteByHubId = z.object({ kind: z.literal('by-hub-id'), hubId: z.string().uuid() });
export type RemoteByHubId = z.infer<typeof RemoteByHubId>;
export const RemoteByHandle = z.object({ kind: z.literal('by-handle'), owner: z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9_-]*$/), principalName: PrincipalName });
export type RemoteByHandle = z.infer<typeof RemoteByHandle>;
export const TargetSpec = z.discriminatedUnion('kind', [RemoteByHubId, RemoteByHandle]);
export type TargetSpec = z.infer<typeof TargetSpec>;
export function formatTargetSpecPath(spec: TargetSpec): string { return spec.kind === 'by-hub-id' ? spec.hubId : `${spec.owner}/${spec.principalName}`; }
export function parseTargetSpecPath(path: string): TargetSpec | null {
  const direct = RemoteByHubId.safeParse({kind: 'by-hub-id', hubId: path});
  if (direct.success) return direct.data;
  const parts = path.split('/');
  if (parts.length !== 2) return null;
  const handle = RemoteByHandle.safeParse({kind: 'by-handle', owner: parts[0], principalName: parts[1]});
  return handle.success ? handle.data : null;
}
