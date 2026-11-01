/**
 * Where people get Peko, and where the docs live. One place, so the
 * landing page, the download page, peko pages, and the footer agree.
 */

/** Peko desktop downloads (macOS, Windows, Linux). */
export const DESKTOP_RELEASES_URL = 'https://github.com/ConekoAI/peko-desktop/releases/latest';

/** The runtime and `peko` CLI, for terminals and servers. */
export const CLI_INSTALL_COMMAND =
  'curl -fsSL https://raw.githubusercontent.com/ConekoAI/peko-runtime/master/install.sh | bash';

export const GETTING_STARTED_URL =
  'https://github.com/ConekoAI/peko-runtime/blob/master/docs/getting-started/GETTING_STARTED.md';
export const DOCS_URL = 'https://github.com/ConekoAI/peko-runtime/tree/master/docs';
export const RUNTIME_REPO_URL = 'https://github.com/ConekoAI/peko-runtime';
export const DESKTOP_REPO_URL = 'https://github.com/ConekoAI/peko-desktop';
export const HUB_REPO_URL = 'https://github.com/ConekoAI/pekohub';

export type Platform = 'macos' | 'windows' | 'linux';

/** The visitor's platform, best guess; `null` on phones and the unknown. */
export function detectPlatform(userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : ''): Platform | null {
  if (/iPhone|iPad|Android/i.test(userAgent)) return null;
  if (/Mac/i.test(userAgent)) return 'macos';
  if (/Win/i.test(userAgent)) return 'windows';
  if (/Linux|X11/i.test(userAgent)) return 'linux';
  return null;
}
