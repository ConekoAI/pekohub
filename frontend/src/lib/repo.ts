/**
 * Registry repository-path helpers.
 *
 * PekoHub is an OCI Distribution v1.1 registry whose repository paths
 * are multi-segment. Per pekohub ADR-005 §2 the seed paths are
 * `peko/principals/<name>`; pre-ADR-005 rows use a two-segment
 * `namespace/name` path and stay readable. The `principals` lane
 * segment is the **wire** vocabulary and is unchanged by ADR-060 —
 * only the user-facing term moved from "template" to "seed".
 *
 * The hub is **seed-only** (runtime ADR-056 D6): a pushed artifact
 * is DNA — a stripped `principal.toml` — never a full-existence
 * snapshot and never a capability package. The retired `extensions/`
 * and `agents/` lanes predate runtime ADR-047 §5 / ADR-050 (where
 * capabilities became plain workspace files) and runtime ADR-037
 * (which superseded the `.agent` bundle); they are surfaced as legacy
 * and filtered out of the seed directory.
 */

/** The only lane a current runtime pushes seeds under. */
export const SEED_LANE = 'principals';

/** Lanes retired by runtime ADR-037 / ADR-047 §5 / ADR-050. */
export const RETIRED_LANES = ['extensions', 'agents', 'teams'] as const;

export interface RepoRef {
  /** Full repository path, e.g. `peko/principals/my-peko`. */
  repo: string;
  /** Everything before the last segment, e.g. `peko/principals`. */
  namespace: string;
  /** Last segment, e.g. `my-peko`. */
  name: string;
  /** Lane segment when the path follows `peko/<lane>/<name>`. */
  lane: string | null;
  /** True when the artifact is a current seed (or a pre-ADR-005 row). */
  isSeed: boolean;
  /** True when the lane was retired by a runtime ADR. */
  isRetired: boolean;
}

/**
 * Classify a repository path. Returns null for anything that isn't a
 * valid `<namespace…>/<name>` repo path.
 */
export function classifyRepo(repo: string): RepoRef | null {
  const segments = repo.split('/').filter(Boolean);
  if (segments.length < 2) return null;

  const name = segments[segments.length - 1];
  const namespace = segments.slice(0, -1).join('/');
  const lane = segments.length === 3 && segments[0] === 'peko' ? segments[1] : null;
  const isRetired = lane !== null && (RETIRED_LANES as readonly string[]).includes(lane);

  return {
    repo,
    namespace,
    name,
    lane,
    isSeed: !isRetired,
    isRetired,
  };
}

/** Human label for a lane. `principals` reads as "seed" in the UI. */
export function laneLabel(lane: string | null): string {
  if (lane === SEED_LANE) return 'seed';
  if (lane === null) return 'legacy path';
  return lane;
}

/** Split a registry ref like `host/peko/principals/foo:1.0.0` into parts. */
export function splitInstallRef(ref: string): {
  host: string | null;
  repo: string;
  tag: string | null;
} | null {
  const trimmed = ref.trim();
  if (!trimmed) return null;

  const colon = trimmed.lastIndexOf(':');
  const hasTag = colon > trimmed.lastIndexOf('/');
  const repo = hasTag ? trimmed.slice(0, colon) : trimmed;
  const tag = hasTag ? trimmed.slice(colon + 1) : null;

  // A host segment is present when the first path segment looks like a
  // registry authority: a dotted name (`pekohub.ai`) or `host:port`
  // (`localhost:5000`, the common local registry).
  const segments = repo.split('/');
  const first = segments[0] ?? '';
  const looksLikeHost = first.includes('.') || /:\d+$/.test(first);
  const hasHost = segments.length > 2 && looksLikeHost;
  const host = hasHost ? first : null;
  const path = hasHost ? segments.slice(1).join('/') : repo;

  return path ? { host, repo: path, tag } : null;
}
