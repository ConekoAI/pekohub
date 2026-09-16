import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { db } from "../../db/index.js";
import { bundles, bundleVersions, blobs, users } from "../../db/schema.js";
import { eq, and, desc } from "drizzle-orm";
import {
  OCIManifest,
  ExtensionManifest,
  PrincipalName,
  OCIAnnotations,
} from "@pekohub/shared";
import crypto from "node:crypto";
import { auditService } from "../../services/audit.js";
import { authenticateOciWrite } from "./auth-write.js";
import type { RepoRef } from "./repo-path.js";

/**
 * OCI Distribution Spec: Manifest operations
 * GET  /v2/<repo>/manifests/<reference>
 * HEAD /v2/<repo>/manifests/<reference>
 * PUT  /v2/<repo>/manifests/<reference>
 *
 * `<repo>` may be multi-segment (`peko/principals/foo`); the wildcard
 * dispatcher in `index.ts` parses it into `RepoRef` before calling
 * these handlers.
 */

/** Shared lookup: bundle row for (namespace, name). */
async function findBundle(namespace: string, name: string) {
  return db.query.bundles.findFirst({
    where: and(eq(bundles.namespace, namespace), eq(bundles.name, name)),
  });
}

/** Shared lookup: version row for a bundle by tag / digest / 'latest'. */
async function findVersion(bundleId: number, reference: string) {
  if (reference === "latest") {
    return db.query.bundleVersions.findFirst({
      where: eq(bundleVersions.bundleId, bundleId),
      orderBy: [desc(bundleVersions.createdAt)],
    });
  }
  return db.query.bundleVersions.findFirst({
    where: and(
      eq(bundleVersions.bundleId, bundleId),
      reference.startsWith("sha256:")
        ? eq(bundleVersions.digest, reference)
        : eq(bundleVersions.version, reference),
    ),
  });
}

export async function getManifest(
  _fastify: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  m: RepoRef & { reference: string },
) {
  const { namespace, name, reference } = m;

  const bundle = await findBundle(namespace, name);

  if (!bundle) {
    return reply.status(404).send({
      errors: [
        {
          code: "NAME_UNKNOWN",
          message: `Bundle ${namespace}/${name} not found`,
        },
      ],
    });
  }

  const version = await findVersion(bundle.id, reference);

  if (!version) {
    return reply.status(404).send({
      errors: [
        {
          code: "MANIFEST_UNKNOWN",
          message: `Manifest ${reference} not found`,
        },
      ],
    });
  }

  const manifest = version.manifestJson as Record<string, unknown>;

  reply.header(
    "Content-Type",
    manifest.mediaType ?? "application/vnd.oci.image.manifest.v1+json",
  );
  reply.header("Docker-Content-Digest", version.digest);
  reply.header("Content-Length", JSON.stringify(manifest).length);

  // Fire-and-forget audit log (must not throw)
  const userId = (request as unknown as { user?: { id?: string } }).user?.id;
  await auditService.logPull(
    namespace,
    userId,
    name,
    version.version,
    version.digest,
    { manifestSize: JSON.stringify(manifest).length },
  );

  return manifest;
}

export async function headManifest(
  _fastify: FastifyInstance,
  _request: FastifyRequest,
  reply: FastifyReply,
  m: RepoRef & { reference: string },
) {
  const { namespace, name, reference } = m;

  const bundle = await findBundle(namespace, name);

  if (!bundle) {
    return reply.status(404).send();
  }

  const version = await findVersion(bundle.id, reference);

  if (!version) {
    return reply.status(404).send();
  }

  const manifest = version.manifestJson as Record<string, unknown>;

  reply.header(
    "Content-Type",
    manifest.mediaType ?? "application/vnd.oci.image.manifest.v1+json",
  );
  reply.header("Docker-Content-Digest", version.digest);
  reply.header("Content-Length", JSON.stringify(manifest).length);
  reply.status(200).send();
}

/**
 * Derive the bundle type for a newly-pushed bundle.
 *
 * Precedence (ADR-056 template artifacts):
 *   1. `dev.pekohub.bundleType` when present — `principal`/`extension`
 *      accepted; `agent`/`team` (and any other retired value) → 410.
 *   2. Otherwise `org.peko.kind` — `principal`/`extension` map 1:1.
 *      The runtime never emits kind `agent` as a principal-template
 *      alias (its only production push path hard-codes
 *      `.with_kind("principal")` — peko-rs/core/src/registry/client.rs),
 *      so `agent` → 410 like the retired bundleType values.
 *   3. Neither annotation → default `principal` (pre-annotation CLI
 *      builds pushed bare OCI manifests for .peko packages).
 *
 * Returns null when the push must be rejected with 410 Gone.
 */
function deriveBundleType(
  annotations: Record<string, string>,
): "principal" | "extension" | null {
  const explicit = annotations[OCIAnnotations.DEV_PEKOHUB_BUNDLE_TYPE];
  if (explicit !== undefined) {
    return explicit === "principal" || explicit === "extension"
      ? explicit
      : null;
  }
  const kind = annotations[OCIAnnotations.ORG_PEKO_KIND];
  if (kind === "principal" || kind === "extension") return kind;
  if (kind === "agent") return null;
  return "principal";
}

export async function putManifest(
  fastify: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  m: RepoRef & { reference: string },
) {
  const { namespace, name, reference } = m;

  const user = await authenticateOciWrite(fastify, request, namespace);
  if (!user) {
    return reply.status(401).send({
      errors: [{ code: "UNAUTHORIZED", message: "Authentication required" }],
    });
  }

  // Validate reference is a tag, not a digest
  if (reference.startsWith("sha256:")) {
    return reply.status(400).send({
      errors: [
        { code: "TAG_INVALID", message: "Cannot push manifest by digest" },
      ],
    });
  }

  // Parse body — may be Buffer from custom content type parser, or already-parsed JSON
  let body: Record<string, unknown>;
  if (Buffer.isBuffer(request.body)) {
    body = JSON.parse(request.body.toString("utf8"));
  } else {
    body = request.body as Record<string, unknown>;
  }
  const manifestParse = OCIManifest.safeParse(body);

  if (!manifestParse.success) {
    return reply.status(400).send({
      errors: [
        {
          code: "MANIFEST_INVALID",
          message: "Invalid OCI manifest",
          detail: manifestParse.error.format(),
        },
      ],
    });
  }

  const manifest = manifestParse.data;

  // Inner-config identity validation (audit section 7).
  //
  // PekoHub does not parse the TOML config blob (the runtime's
  // template `principal.toml` under media type
  // `application/vnd.peko.config.v1+json`), so a path-traversal
  // spelling in the inner `principal.name` or `extension.id` would
  // otherwise reach the DB unchecked. The runtime emits the same
  // names in flat `dev.pekohub.*` annotations so we can validate
  // them here against the runtime's `validate_agent_name`-equivalent
  // Zod schemas. The runtime rejects the same set upstream, so this
  // is a defense-in-depth check, not a primary gate.
  const annotations = (manifest.annotations ?? {}) as Record<string, string>;
  const principalName = annotations[OCIAnnotations.DEV_PEKOHUB_PRINCIPAL_NAME];
  if (principalName !== undefined) {
    const r = PrincipalName.safeParse(principalName);
    if (!r.success) {
      return reply.status(400).send({
        errors: [
          {
            code: "MANIFEST_INVALID",
            message: "Invalid dev.pekohub.principalName annotation",
            detail: r.error.format(),
          },
        ],
      });
    }
  }
  const extensionId = annotations[OCIAnnotations.DEV_PEKOHUB_EXTENSION_ID];
  if (extensionId !== undefined) {
    const r = ExtensionManifest.shape.id.safeParse(extensionId);
    if (!r.success) {
      return reply.status(400).send({
        errors: [
          {
            code: "MANIFEST_INVALID",
            message: "Invalid dev.pekohub.extensionId annotation",
            detail: r.error.format(),
          },
        ],
      });
    }
  }

  // Verify all referenced blobs exist. ADR-056 template artifacts are
  // zero-layer: only the config descriptor (the template TOML blob)
  // is checked. The config blob is never parsed — identity comes from
  // the flat annotations validated above.
  const allDescriptors = [manifest.config, ...manifest.layers];
  for (const desc of allDescriptors) {
    const blob = await db.query.blobs.findFirst({
      where: eq(blobs.digest, desc.digest),
    });
    if (!blob) {
      return reply.status(400).send({
        errors: [
          {
            code: "BLOB_UNKNOWN",
            message: `Referenced blob ${desc.digest} not found`,
          },
        ],
      });
    }
  }

  // Compute manifest digest
  const manifestBytes = Buffer.from(JSON.stringify(body));
  const digest =
    "sha256:" +
    crypto.createHash("sha256").update(manifestBytes).digest("hex");

  // Upsert bundle
  let bundle = await findBundle(namespace, name);

  // Helper to parse JSON annotation values (arrays/objects)
  function parseJsonAnnotation<T>(key: string): T | undefined {
    const raw = annotations[key];
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  if (!bundle) {
    // Publisher model (ADR-056): the first pusher owns the bundle.
    //
    // Squatting protection: a single-segment namespace that is
    // ANOTHER user's namespace (e.g. `alice/*` pushed by bob) is
    // rejected. Multi-segment namespaces (`peko/principals`, org
    // paths) belong to no one and are first-come, first-served —
    // ownership is tracked on the bundle row itself via
    // `publisher_id`, not on the namespace.
    if (!namespace.includes("/") && namespace !== user.namespace) {
      const nsOwner = await db.query.users.findFirst({
        where: eq(users.namespace, namespace),
      });
      if (nsOwner) {
        return reply.status(403).send({
          errors: [
            {
              code: "DENIED",
              message: `Namespace '${namespace}' belongs to another user`,
            },
          ],
        });
      }
    }

    const bundleType = deriveBundleType(annotations);
    if (bundleType === null) {
      const attempted =
        annotations[OCIAnnotations.DEV_PEKOHUB_BUNDLE_TYPE] ??
        annotations[OCIAnnotations.ORG_PEKO_KIND];
      return reply
        .status(410)
        .send({ error: `Bundle type '${attempted}' is no longer supported. Use 'principal' or 'extension'.` });
    }
    const [inserted] = await db
      .insert(bundles)
      .values({
        namespace,
        name,
        bundleType,
        // `user.id` is undefined on the dev-auth-bypass path; the row
        // then stays claimable like a legacy NULL-publisher bundle.
        publisherId: user.id ?? null,
        extensionType: annotations["dev.pekohub.extensionType"] as any,
        description:
          annotations["org.opencontainers.image.description"] ?? null,
        author: annotations["org.opencontainers.image.authors"] ?? null,
        license: annotations["org.opencontainers.image.licenses"] ?? null,
        tags: parseJsonAnnotation<string[]>("dev.pekohub.tags"),
        categories: parseJsonAnnotation<string[]>("dev.pekohub.categories"),
        modelProviders: parseJsonAnnotation<string[]>(
          "dev.pekohub.modelProviders",
        ),
        requiredMcpServers: parseJsonAnnotation<string[]>(
          "dev.pekohub.requiredMcpServers",
        ),
        readme: annotations["dev.pekohub.readme"] ?? null,
        hooks:
          parseJsonAnnotation<
            Array<{ point: string; handler?: string; topicPattern?: string }>
          >("dev.pekohub.hooks"),
        compatibility: parseJsonAnnotation<{
          runtime?: string;
          minVersion?: string;
          maxVersion?: string;
        }>("dev.pekohub.compatibility"),
      })
      .returning();
    bundle = inserted;
  } else if (bundle.publisherId) {
    // Publisher-owned bundle: only the publisher may push.
    if (!user.id || bundle.publisherId !== user.id) {
      return reply.status(403).send({
        errors: [
          {
            code: "DENIED",
            message: `Bundle ${namespace}/${name} is published by another account`,
          },
        ],
      });
    }
  } else {
    // Legacy NULL-publisher bundle: claimable by the caller whose
    // namespace matches the bundle namespace (the pre-publisher
    // ownership rule). Dev-bypass callers (no id) pass through
    // without claiming.
    if (user.id && user.namespace === bundle.namespace) {
      await db
        .update(bundles)
        .set({ publisherId: user.id })
        .where(eq(bundles.id, bundle.id));
      bundle = { ...bundle, publisherId: user.id };
    } else if (user.id) {
      return reply.status(403).send({
        errors: [
          {
            code: "DENIED",
            message: `Bundle ${namespace}/${name} is not owned by this account`,
          },
        ],
      });
    }
  }

  // Upsert version
  const existingVersion = await db.query.bundleVersions.findFirst({
    where: and(
      eq(bundleVersions.bundleId, bundle.id),
      eq(bundleVersions.version, reference),
    ),
  });

  if (existingVersion) {
    // Immutable: don't overwrite existing version
    return reply.status(409).send({
      errors: [
        {
          code: "MANIFEST_INVALID",
          message: `Version ${reference} already exists`,
        },
      ],
    });
  }

  await db.insert(bundleVersions).values({
    bundleId: bundle.id,
    version: reference,
    digest,
    manifestJson: body,
    size: manifestBytes.length,
  });

  // Update bundle metadata from annotations if present
  await db
    .update(bundles)
    .set({
      description:
        annotations["org.opencontainers.image.description"] ??
        bundle.description,
      author:
        annotations["org.opencontainers.image.authors"] ?? bundle.author,
      license:
        annotations["org.opencontainers.image.licenses"] ?? bundle.license,
      tags: parseJsonAnnotation<string[]>("dev.pekohub.tags") ?? bundle.tags,
      categories:
        parseJsonAnnotation<string[]>("dev.pekohub.categories") ??
        bundle.categories,
      modelProviders:
        parseJsonAnnotation<string[]>("dev.pekohub.modelProviders") ??
        bundle.modelProviders,
      requiredMcpServers:
        parseJsonAnnotation<string[]>("dev.pekohub.requiredMcpServers") ??
        bundle.requiredMcpServers,
      readme: annotations["dev.pekohub.readme"] ?? bundle.readme,
      hooks:
        parseJsonAnnotation<
          Array<{ point: string; handler?: string; topicPattern?: string }>
        >("dev.pekohub.hooks") ?? bundle.hooks,
      compatibility:
        parseJsonAnnotation<{
          runtime?: string;
          minVersion?: string;
          maxVersion?: string;
        }>("dev.pekohub.compatibility") ?? bundle.compatibility,
      updatedAt: new Date(),
    })
    .where(eq(bundles.id, bundle.id));

  // Index into Meilisearch for discovery
  try {
    await fastify.search.indexBundle({
      objectID: `${namespace}-${name}-${reference}`,
      namespace,
      name,
      version: reference,
      description: bundle.description ?? undefined,
      author: bundle.author ?? "unknown",
      bundleType: bundle.bundleType,
      extensionType: bundle.extensionType ?? undefined,
      tags: bundle.tags ?? undefined,
      pullCount: bundle.pullCount,
      starCount: bundle.starCount,
      updatedAt: new Date().toISOString(),
      hooks:
        (bundle.hooks as
          | Array<{
              point: import("@pekohub/shared").HookPoint;
              handler?: string;
              topicPattern?: string;
            }>
          | undefined) ?? undefined,
      compatibility:
        parseJsonAnnotation<{
          runtime?: string;
          minVersion?: string;
          maxVersion?: string;
        }>("dev.pekohub.compatibility") ??
        bundle.compatibility ??
        undefined,
    });
  } catch (err) {
    fastify.log.warn({ err }, "Failed to index bundle in Meilisearch");
  }

  reply.header("Location", `/v2/${namespace}/${name}/manifests/${digest}`);
  reply.header("Docker-Content-Digest", digest);
  reply.status(201).send();

  // Fire-and-forget audit log (must not throw)
  await auditService.logPush(namespace, user.id, name, reference, digest, {
    size: manifestBytes.length,
  });
}
