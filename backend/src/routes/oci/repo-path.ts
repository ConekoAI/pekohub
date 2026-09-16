/**
 * Multi-segment OCI repository path parsing.
 *
 * Fastify route params cannot cross `/`, and wildcards are only
 * allowed as the final token, so `/v2/peko/principals/<name>/...`
 * cannot be expressed as `:namespace/:name`. Instead the OCI routes
 * register `/v2/*` wildcard handlers and parse the repository path
 * here: the repo is everything before the `/manifests|/blobs|/tags`
 * suffix, `name` is its last segment, and `namespace` is the rest
 * (so `peko/principals/foo` → namespace `peko/principals`, name
 * `foo`; legacy `alice/foo` → namespace `alice`, name `foo`).
 */

export interface RepoRef {
  namespace: string;
  name: string;
}

/** Split a repository path into namespace (up to last '/') + name. */
export function splitRepo(repo: string): RepoRef | null {
  const idx = repo.lastIndexOf("/");
  if (idx <= 0 || idx === repo.length - 1) return null;
  return { namespace: repo.slice(0, idx), name: repo.slice(idx + 1) };
}

export type V2Match =
  | ({ kind: "blob" } & RepoRef & { digest: string })
  | ({ kind: "blobUploadInit" } & RepoRef)
  | ({ kind: "blobUploadComplete" } & RepoRef & { uuid: string })
  | ({ kind: "manifest" } & RepoRef & { reference: string })
  | ({ kind: "tags" } & RepoRef);

/**
 * Parse the wildcard portion of a `/v2/*` URL into a typed match.
 * Returns null when the shape is not a recognized OCI suffix or the
 * repo path is not a valid `namespace/name` split.
 */
export function parseV2Wildcard(wildcard: string): V2Match | null {
  if (!wildcard) return null;

  // Tags: <repo>/tags/list
  if (wildcard.endsWith("/tags/list")) {
    const repo = splitRepo(wildcard.slice(0, -"/tags/list".length));
    return repo ? { kind: "tags", ...repo } : null;
  }

  // Blobs: <repo>/blobs/<digest> | <repo>/blobs/uploads[/] | <repo>/blobs/uploads/<uuid>
  const blobsIdx = wildcard.lastIndexOf("/blobs/");
  if (blobsIdx > 0) {
    const repo = splitRepo(wildcard.slice(0, blobsIdx));
    if (!repo) return null;
    const rest = wildcard.slice(blobsIdx + "/blobs/".length);
    if (rest === "uploads" || rest === "uploads/") {
      return { kind: "blobUploadInit", ...repo };
    }
    if (rest.startsWith("uploads/")) {
      const uuid = rest.slice("uploads/".length);
      if (!uuid || uuid.includes("/")) return null;
      return { kind: "blobUploadComplete", ...repo, uuid };
    }
    if (!rest || rest.includes("/")) return null;
    return { kind: "blob", ...repo, digest: rest };
  }

  // Manifests: <repo>/manifests/<reference>
  const manifestsIdx = wildcard.lastIndexOf("/manifests/");
  if (manifestsIdx > 0) {
    const repo = splitRepo(wildcard.slice(0, manifestsIdx));
    if (!repo) return null;
    const reference = wildcard.slice(manifestsIdx + "/manifests/".length);
    if (!reference || reference.includes("/")) return null;
    return { kind: "manifest", ...repo, reference };
  }

  return null;
}
