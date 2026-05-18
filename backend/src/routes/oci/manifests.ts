import type { FastifyInstance } from 'fastify';
import { db } from '../../db/index.js';
import { bundles, bundleVersions, blobs } from '../../db/schema.js';
import { eq, and, desc } from 'drizzle-orm';
import { OCIManifest } from '@pekohub/shared';
import crypto from 'node:crypto';
import { auditService } from '../../services/audit.js';

/**
 * OCI Distribution Spec: Manifest operations
 * GET  /v2/{namespace}/{name}/manifests/{reference}
 * HEAD /v2/{namespace}/{name}/manifests/{reference}
 * PUT  /v2/{namespace}/{name}/manifests/{reference}
 * DELETE /v2/{namespace}/{name}/manifests/{reference}
 *
 * Note: This route is registered with prefix /v2/:namespace/:name
 * so handler paths are relative to that (e.g. /manifests/:reference)
 */
export default async function manifestRoutes(fastify: FastifyInstance) {
  // GET manifest
  fastify.get('/manifests/:reference', async (request, reply) => {
    const { namespace, name, reference } = request.params as {
      namespace: string;
      name: string;
      reference: string;
    };

    const bundle = await db.query.bundles.findFirst({
      where: and(eq(bundles.namespace, namespace), eq(bundles.name, name)),
    });

    if (!bundle) {
      return reply.status(404).send({
        errors: [{ code: 'NAME_UNKNOWN', message: `Bundle ${namespace}/${name} not found` }],
      });
    }

    // Find version by tag, digest, or resolve 'latest' to newest version
    let version;
    if (reference === 'latest') {
      version = await db.query.bundleVersions.findFirst({
        where: eq(bundleVersions.bundleId, bundle.id),
        orderBy: [desc(bundleVersions.createdAt)],
      });
    } else {
      version = await db.query.bundleVersions.findFirst({
        where: and(
          eq(bundleVersions.bundleId, bundle.id),
          reference.startsWith('sha256:')
            ? eq(bundleVersions.digest, reference)
            : eq(bundleVersions.version, reference)
        ),
      });
    }

    if (!version) {
      return reply.status(404).send({
        errors: [{ code: 'MANIFEST_UNKNOWN', message: `Manifest ${reference} not found` }],
      });
    }

    const manifest = version.manifestJson as Record<string, unknown>;

    reply.header('Content-Type', manifest.mediaType ?? 'application/vnd.oci.image.manifest.v1+json');
    reply.header('Docker-Content-Digest', version.digest);
    reply.header('Content-Length', JSON.stringify(manifest).length);

    return manifest;
  });

  // HEAD manifest
  fastify.head('/manifests/:reference', async (request, reply) => {
    const { namespace, name, reference } = request.params as {
      namespace: string;
      name: string;
      reference: string;
    };

    const bundle = await db.query.bundles.findFirst({
      where: and(eq(bundles.namespace, namespace), eq(bundles.name, name)),
    });

    if (!bundle) {
      return reply.status(404).send();
    }

    let version;
    if (reference === 'latest') {
      version = await db.query.bundleVersions.findFirst({
        where: eq(bundleVersions.bundleId, bundle.id),
        orderBy: [desc(bundleVersions.createdAt)],
      });
    } else {
      version = await db.query.bundleVersions.findFirst({
        where: and(
          eq(bundleVersions.bundleId, bundle.id),
          reference.startsWith('sha256:')
            ? eq(bundleVersions.digest, reference)
            : eq(bundleVersions.version, reference)
        ),
      });
    }

    if (!version) {
      return reply.status(404).send();
    }

    const manifest = version.manifestJson as Record<string, unknown>;

    reply.header('Content-Type', manifest.mediaType ?? 'application/vnd.oci.image.manifest.v1+json');
    reply.header('Docker-Content-Digest', version.digest);
    reply.header('Content-Length', JSON.stringify(manifest).length);
    reply.status(200).send();
  });

  // PUT manifest — requires auth
  fastify.put('/manifests/:reference', async (request, reply) => {
    let user: { namespace: string };
    try {
      user = await fastify.authenticate(request);
    } catch {
      // Allow unauthenticated pushes in development when explicitly enabled
      if (fastify.config.NODE_ENV === 'development' && fastify.config.ALLOW_DEV_AUTH_BYPASS === 'true') {
        user = { namespace: (request.params as { namespace: string }).namespace };
      } else {
        return reply.status(401).send({
          errors: [{ code: 'UNAUTHORIZED', message: 'Authentication required' }],
        });
      }
    }
    const { namespace, name, reference } = request.params as {
      namespace: string;
      name: string;
      reference: string;
    };

    // Namespace ownership check
    if (user.namespace !== namespace) {
      return reply.status(403).send({
        errors: [{ code: 'DENIED', message: 'Namespace ownership mismatch' }],
      });
    }

    // Validate reference is a tag, not a digest
    if (reference.startsWith('sha256:')) {
      return reply.status(400).send({
        errors: [{ code: 'TAG_INVALID', message: 'Cannot push manifest by digest' }],
      });
    }

    // Parse body — may be Buffer from custom content type parser, or already-parsed JSON
    let body: Record<string, unknown>;
    if (Buffer.isBuffer(request.body)) {
      body = JSON.parse(request.body.toString('utf8'));
    } else {
      body = request.body as Record<string, unknown>;
    }
    const manifestParse = OCIManifest.safeParse(body);

    if (!manifestParse.success) {
      return reply.status(400).send({
        errors: [{ code: 'MANIFEST_INVALID', message: 'Invalid OCI manifest', detail: manifestParse.error.format() }],
      });
    }

    const manifest = manifestParse.data;

    // Verify all referenced blobs exist
    const allDescriptors = [manifest.config, ...manifest.layers];
    for (const desc of allDescriptors) {
      const blob = await db.query.blobs.findFirst({
        where: eq(blobs.digest, desc.digest),
      });
      if (!blob) {
        return reply.status(400).send({
          errors: [{ code: 'BLOB_UNKNOWN', message: `Referenced blob ${desc.digest} not found` }],
        });
      }
    }

    // Compute manifest digest
    const manifestBytes = Buffer.from(JSON.stringify(body));
    const digest = 'sha256:' + crypto.createHash('sha256').update(manifestBytes).digest('hex');

    // Upsert bundle
    let bundle = await db.query.bundles.findFirst({
      where: and(eq(bundles.namespace, namespace), eq(bundles.name, name)),
    });

    // Extract Pekohub metadata from annotations if present
    const annotations = (manifest.annotations ?? {}) as Record<string, string>;
    const pekoMetadataRaw = annotations['dev.pekohub.metadata'];
    let parsedMetadata: { bundleType?: string; extensionType?: string; tags?: string[]; description?: string; author?: string; license?: string; readme?: string; categories?: string[]; modelProviders?: string[]; requiredMcpServers?: string[]; hooks?: Array<{ point: string; handler?: string; topicPattern?: string }>; compatibility?: { runtime?: string; minVersion?: string; maxVersion?: string } } | undefined;
    if (pekoMetadataRaw) {
      try {
        parsedMetadata = JSON.parse(pekoMetadataRaw);
      } catch {
        // ignore invalid metadata
      }
    }

    if (!bundle) {
      const [inserted] = await db.insert(bundles).values({
        namespace,
        name,
        bundleType: (parsedMetadata?.bundleType ?? annotations['dev.pekohub.bundleType'] ?? 'agent') as 'agent' | 'team' | 'extension',
        extensionType: parsedMetadata?.extensionType as any,
        description: parsedMetadata?.description ?? annotations['org.opencontainers.image.description'] ?? null,
        author: parsedMetadata?.author ?? annotations['org.opencontainers.image.authors'] ?? null,
        license: annotations['org.opencontainers.image.licenses'] ?? null,
        tags: parsedMetadata?.tags ?? null,
        categories: parsedMetadata?.categories ?? null,
        modelProviders: parsedMetadata?.modelProviders ?? null,
        requiredMcpServers: parsedMetadata?.requiredMcpServers ?? null,
        readme: parsedMetadata?.readme ?? null,
        hooks: parsedMetadata?.hooks ?? null,
        compatibility: parsedMetadata?.compatibility ?? null,
      }).returning();
      bundle = inserted;
    }

    // Upsert version
    const existingVersion = await db.query.bundleVersions.findFirst({
      where: and(eq(bundleVersions.bundleId, bundle.id), eq(bundleVersions.version, reference)),
    });

    if (existingVersion) {
      // Immutable: don't overwrite existing version
      return reply.status(409).send({
        errors: [{ code: 'MANIFEST_INVALID', message: `Version ${reference} already exists` }],
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
    await db.update(bundles)
      .set({
        description: parsedMetadata?.description ?? annotations['org.opencontainers.image.description'] ?? bundle.description,
        author: parsedMetadata?.author ?? annotations['org.opencontainers.image.authors'] ?? bundle.author,
        license: annotations['org.opencontainers.image.licenses'] ?? bundle.license,
        tags: parsedMetadata?.tags ?? bundle.tags,
        categories: parsedMetadata?.categories ?? bundle.categories,
        modelProviders: parsedMetadata?.modelProviders ?? bundle.modelProviders,
        requiredMcpServers: parsedMetadata?.requiredMcpServers ?? bundle.requiredMcpServers,
        readme: parsedMetadata?.readme ?? bundle.readme,
        hooks: parsedMetadata?.hooks ?? bundle.hooks,
        compatibility: parsedMetadata?.compatibility ?? bundle.compatibility,
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
        author: bundle.author ?? 'unknown',
        bundleType: bundle.bundleType,
        extensionType: bundle.extensionType ?? undefined,
        tags: bundle.tags ?? undefined,
        pullCount: bundle.pullCount,
        starCount: bundle.starCount,
        updatedAt: new Date().toISOString(),
        hooks: parsedMetadata?.hooks ?? bundle.hooks ?? undefined,
        compatibility: parsedMetadata?.compatibility ?? bundle.compatibility ?? undefined,
      });
    } catch (err) {
      fastify.log.warn({ err }, 'Failed to index bundle in Meilisearch');
    }

    reply.header('Location', `/v2/${namespace}/${name}/manifests/${digest}`);
    reply.header('Docker-Content-Digest', digest);
    reply.status(201).send();

    // Fire-and-forget audit log (must not throw)
    const userId = (user as { id?: number }).id;
    await auditService.logPush(namespace, userId, name, reference, digest, { size: manifestBytes.length });
  });
}
