import { z } from 'zod';

/**
 * OCI Descriptor — used for manifests, configs, and layers
 */
export const OCIDescriptor = z.object({
  mediaType: z.string(),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/, 'Invalid digest format'),
  size: z.number().int().nonnegative(),
  urls: z.array(z.string().url()).optional(),
  annotations: z.record(z.string()).optional(),
});
export type OCIDescriptor = z.infer<typeof OCIDescriptor>;

/**
 * OCI Manifest — core bundle manifest
 */
export const OCIManifest = z.object({
  schemaVersion: z.literal(2),
  mediaType: z.string().optional(),
  config: OCIDescriptor,
  layers: z.array(OCIDescriptor),
  annotations: z.record(z.string()).optional(),
});
export type OCIManifest = z.infer<typeof OCIManifest>;

/**
 * OCI Index — multi-arch / multi-variant manifest list
 */
export const OCIIndex = z.object({
  schemaVersion: z.literal(2),
  mediaType: z.string().optional(),
  manifests: z.array(OCIDescriptor),
  annotations: z.record(z.string()).optional(),
});
export type OCIIndex = z.infer<typeof OCIIndex>;

/**
 * OCI Error response
 */
export const OCIError = z.object({
  errors: z.array(
    z.object({
      code: z.string(),
      message: z.string(),
      detail: z.unknown().optional(),
    })
  ),
});
export type OCIError = z.infer<typeof OCIError>;

/**
 * Parse a bundle reference: namespace/name:tag or namespace/name@digest
 */
export function parseBundleReference(ref: string): {
  namespace: string;
  name: string;
  reference: string;
} {
  const atIdx = ref.lastIndexOf('@');
  const colonIdx = ref.lastIndexOf(':');
  const sepIdx = atIdx !== -1 ? atIdx : colonIdx !== -1 ? colonIdx : -1;

  if (sepIdx === -1) {
    throw new Error(`Invalid bundle reference: ${ref}`);
  }

  const namePart = ref.slice(0, sepIdx);
  const reference = ref.slice(sepIdx + 1);
  const slashIdx = namePart.lastIndexOf('/');

  if (slashIdx === -1) {
    throw new Error(`Invalid bundle reference (missing namespace): ${ref}`);
  }

  return {
    namespace: namePart.slice(0, slashIdx),
    name: namePart.slice(slashIdx + 1),
    reference,
  };
}
