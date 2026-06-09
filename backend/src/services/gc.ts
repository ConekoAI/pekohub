import { db } from "../db/index.js";
import { blobs, bundleVersions } from "../db/schema.js";
import { lt, eq } from "drizzle-orm";
import type { StorageService } from "../plugins/storage.js";

export interface GarbageCollectionConfig {
  // Retention period in days before a blob can be garbage collected
  retentionDays?: number;
  // Dry run mode - log what would be deleted without actually deleting
  dryRun?: boolean;
  // Maximum number of blobs to delete per run
  batchSize?: number;
}

export interface GarbageCollectionResult {
  blobsScanned: number;
  blobsDeleted: number;
  bytesFreed: number;
  errors: string[];
}

/**
 * Garbage collection service for unreferenced blobs
 * REG-005: Registry MUST support garbage collection of unreferenced blobs
 */
export class GarbageCollector {
  constructor(private storage: StorageService) {}

  /**
   * Run garbage collection to find and delete unreferenced blobs
   */
  async collect(
    config: GarbageCollectionConfig = {},
  ): Promise<GarbageCollectionResult> {
    const { retentionDays = 7, dryRun = false, batchSize = 1000 } = config;

    const result: GarbageCollectionResult = {
      blobsScanned: 0,
      blobsDeleted: 0,
      bytesFreed: 0,
      errors: [],
    };

    try {
      // Get all referenced blob digests from manifests
      const manifestVersions = await db.query.bundleVersions.findMany();
      const referencedDigests = new Set<string>();

      for (const version of manifestVersions) {
        const manifest = version.manifestJson as any;
        if (manifest.layers) {
          for (const layer of manifest.layers) {
            if (layer.digest) {
              referencedDigests.add(layer.digest);
            }
          }
        }
        // Also include config blob
        if (manifest.config?.digest) {
          referencedDigests.add(manifest.config.digest);
        }
      }

      // Calculate cutoff date for retention
      const cutoffDate = new Date(
        Date.now() - retentionDays * 24 * 60 * 60 * 1000,
      );

      // Find all blobs older than retention period
      const oldBlobs = await db
        .select()
        .from(blobs)
        .where(lt(blobs.uploadedAt, cutoffDate))
        .limit(batchSize);

      // Filter to only those not referenced
      const unreferencedBlobs = oldBlobs.filter(
        (blob) => !referencedDigests.has(blob.digest),
      );

      result.blobsScanned = unreferencedBlobs.length;

      if (!dryRun) {
        // Delete blobs from storage and database
        for (const blob of unreferencedBlobs) {
          try {
            // Delete from storage
            await this.storage.delete(blob.storageKey);

            // Delete from database
            await db.delete(blobs).where(eq(blobs.digest, blob.digest));

            result.blobsDeleted++;
            result.bytesFreed += blob.size;
          } catch (err) {
            result.errors.push(
              `Failed to delete blob ${blob.digest}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    } catch (err) {
      result.errors.push(
        `Garbage collection failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return result;
  }

  /**
   * Get size of unreferenced blobs (useful for estimating cleanup potential)
   */
  async estimateUnreferencedSize(retentionDays: number = 7): Promise<number> {
    const manifestVersions = await db.query.bundleVersions.findMany();
    const referencedDigests = new Set<string>();

    for (const version of manifestVersions) {
      const manifest = version.manifestJson as any;
      if (manifest.layers) {
        for (const layer of manifest.layers) {
          if (layer.digest) {
            referencedDigests.add(layer.digest);
          }
        }
      }
      if (manifest.config?.digest) {
        referencedDigests.add(manifest.config.digest);
      }
    }

    const cutoffDate = new Date(
      Date.now() - retentionDays * 24 * 60 * 60 * 1000,
    );

    // Find all old blobs
    const oldBlobs = await db
      .select()
      .from(blobs)
      .where(lt(blobs.uploadedAt, cutoffDate));

    // Filter to only those not referenced
    const unreferencedBlobs = oldBlobs.filter(
      (blob) => !referencedDigests.has(blob.digest),
    );

    return unreferencedBlobs.reduce((sum, blob) => sum + blob.size, 0);
  }
}
