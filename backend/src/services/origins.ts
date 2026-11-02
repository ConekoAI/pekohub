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

/**
 * Page links on the website (hub ADR-009 D1): a page's path is its ID —
 * `/@alice` for a person, `/@alice/ada` for a peko, `/alice/ada` for a
 * seed. Handles and names are URL-safe by their own rules; encoding keeps
 * an odd legacy row from breaking the link.
 */
export function personUrl(config: Config, handle: string): string {
  return `${webOrigin(config)}/@${encodeURIComponent(handle)}`;
}

export function pekoUrl(config: Config, owner: string, name: string): string {
  return `${webOrigin(config)}/@${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

export function seedUrl(config: Config, owner: string, name: string): string {
  return `${webOrigin(config)}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

/** A public peko's share link on the website; null when it has none. */
export function pekoShareUrl(
  config: Config,
  peko: { name: string; ownerHandle: string | null; exposure: string },
): string | null {
  if (peko.exposure !== "public" || !peko.ownerHandle) return null;
  return pekoUrl(config, peko.ownerHandle, peko.name);
}
