import type { FastifyInstance, FastifyRequest } from "fastify";

/**
 * Shared auth helper for the OCI write routes (blob upload +
 * manifest PUT). Production requires a JWT or `pkr_` API key; in
 * development, when `ALLOW_DEV_AUTH_BYPASS=true`, unauthenticated
 * calls fall back to a synthetic namespace-scoped user so local CLI
 * flows keep working without a login (matches the pre-existing
 * manifest PUT behavior).
 *
 * Returns the authenticated user, or null when the caller is
 * unauthenticated and the bypass is disabled (the caller must then
 * 401).
 */
export async function authenticateOciWrite(
  fastify: FastifyInstance,
  request: FastifyRequest,
  bypassNamespace: string,
): Promise<{ id?: string; namespace: string } | null> {
  try {
    return await fastify.authenticate(request);
  } catch {
    if (
      fastify.config.NODE_ENV === "development" &&
      fastify.config.ALLOW_DEV_AUTH_BYPASS === "true"
    ) {
      return { namespace: bypassNamespace };
    }
    return null;
  }
}
