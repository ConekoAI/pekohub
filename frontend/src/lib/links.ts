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

/**
 * A prompt to paste into a coding agent (Claude Code, Codex, …) so it
 * installs Peko and sets up a first peko. Mirrors the runtime's Getting
 * Started guide; keep the two in step. The agent asks for anything only
 * the person knows — the model, the key, the name.
 */
export const AGENT_SETUP_PROMPT = `Set up Peko on this computer for me. Peko runs persistent AI agents ("pekos") locally. It supports macOS and Linux.

1. Install the peko CLI:
   ${CLI_INSTALL_COMMAND}
2. Ask me which model to use: its API format (anthropic_messages, openai_completions or openai_responses), base URL, model ID, and my API key. Then run:
   peko model add --id my-model --api-format <format> --base-url <url> --model <model-id> --key "<key>"
   (For a local model that needs no key, use --no-key instead of --key.) Check it with: peko model test my-model
3. Start the daemon: peko daemon start
4. Ask me what to call my peko, then: peko create <name> --model my-model
5. Say hello: peko send <name> "Hello, what can you do?"
6. Optional, so my peko can reach pekos on other computers: peko runtime register. It prints a code; show it to me to approve on pekohub.ai.

Never write my API key to a file. If a step fails, read the Troubleshooting section of ${GETTING_STARTED_URL} before retrying.`;
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
