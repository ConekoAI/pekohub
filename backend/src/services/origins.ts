import type { Config } from "../plugins/config.js";

/**
 * The Hub's two origins (gap map C3/C4):
 *   - the API origin (`api.pekohub.ai`): REST, OAuth, and the runtime
 *     tunnel; it is also the bridge-token issuer (`PUBLIC_ORIGIN`);
 *   - the web origin (`pekohub.ai`): the website — share links, seed
 *     pages, sign-in consent (`FRONTEND_URL`).
 * Clients learn both from `GET /v1/meta` and never build one from the other.
 */
export function apiOrigin(config: Config): string {
  return config.PUBLIC_ORIGIN.replace(/\/+$/, "");
}

export function webOrigin(config: Config): string {
  return (config.FRONTEND_URL ?? config.REGISTRY_BASE_URL).replace(/\/+$/, "");
}

/** `https://api…` → `wss://api…/v1/tunnel`. */
export function tunnelUrl(config: Config): string {
  return `${apiOrigin(config).replace(/^http/, "ws")}/v1/tunnel`;
}

/** A public peko's share link on the website; null when it has none. */
export function pekoShareUrl(
  config: Config,
  peko: { name: string; ownerHandle: string | null; exposure: string },
): string | null {
  if (peko.exposure !== "public" || !peko.ownerHandle) return null;
  return `${webOrigin(config)}/peko/${encodeURIComponent(peko.ownerHandle)}/${encodeURIComponent(peko.name)}`;
}
