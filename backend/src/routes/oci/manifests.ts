import type { FastifyInstance } from 'fastify';
import { db } from '../../db/index.js';
import { bundles, bundleVersions, blobs } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { OCIManifest, parseBundleReference } from '@pekohub/shared';

/**
 * OCI Distribution Spec: Manifest operations
 * GET  /v2/{namespace}/{name}/manifests/{reference}
 * HEAD /v2/{namespace}/{name}/manifests/{reference}
 * PUT  /v2/{namespace}/{name}/manifests/{reference}
 * DELETE /v2/{namespace}/{name}/manifests/{reference}
 */
export default async function manifestRoutes(fastify: FastifyInstance) {
  // GET manifest
  fastify.get('/:namespace/:name/manifests/:reference', async (request, reply) => {
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

    // Find version by tag or digest
    const version = await db.query.bundleVersions.findFirst({
      where: and(
        eq(bundleVersions.bundleId, bundle.id),
        reference.startsWith('sha256:')
          ? eq(bundleVersions.digest, reference)
          : eq(bundleVersions.version, reference)
      ),
    });

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
  fastify.head('/:namespace/:name/manifests/:reference', async (request, reply) => {
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

    const version = await db.query.bundleVersions.findFirst({
      where: and(
        eq(bundleVersions.bundleId, bundle.id),
        reference.startsWith('sha256:')
          ? eq(bundleVersions.digest, reference)
          : eq(bundleVersions.version, reference)
      ),
    });

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
  fastify.put('/:namespace/:name/manifests/:reference', async (request, reply) => {
    const user = await fastify.authenticate(request);
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

    const body = request.body as Record<string, unknown>;
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
    const digest = 'sha256:' + require('crypto').createHash('sha256').update(manifestBytes).digest('hex');

    // Upsert bundle
    let bundle = await db.query.bundles.findFirst({
      where: and(eq(bundles.namespace, namespace), eq(bundles.name, name)),
    });

    if (!bundle) {
      const [inserted] = await db.insert(bundles).values({
        namespace,
        name,
        bundleType: 'agent', // Default, can be overridden by manifest annotations
        description: manifest.annotations?.['org.opencontainers.image.description'] ?? null,
        author: manifest.annotations?.['org.opencontainers.image.authors'] ?? null,
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
    const annotations = manifest.annotations ?? {};
    await db.update(bundles)
      .set({
        description: annotations['org.opencontainers.image.description'] ?? bundle.description,
        author: annotations['org.opencontainers.image.authors'] ?? bundle.author,
        updatedAt: new Date(),
      })
      .where(eq(bundles.id, bundle.id));

    reply.header('Location', `/v2/${namespace}/${name}/manifests/${digest}`);
    reply.header('Docker-Content-Digest', digest);
    reply.status(201).send();
  });
}
