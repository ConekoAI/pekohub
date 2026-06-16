import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createTestDb, resetTables } from "../fixtures/db.js";
import { buildTestApp } from "../fixtures/app.js";
import {
  createUser,
  createBundle,
  createBundleVersion,
} from "../fixtures/factories.js";
import { authHeaders } from "../fixtures/auth.js";
import type { TestDb } from "../fixtures/db.js";
import crypto from "node:crypto";

function sha256(buffer: Buffer | string): string {
  return "sha256:" + crypto.createHash("sha256").update(buffer).digest("hex");
}

describe("OCI Distribution API", () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  });

  beforeEach(async () => {
    await resetTables(testDb.client);
  });

  afterAll(async () => {
    await testDb.client.close();
  });

  describe("GET /v2/:namespace/:name/blobs/:digest", () => {
    it("throttles pull_stats writes for repeated pulls of same digest from same IP", async () => {
      const app = await buildTestApp({ testDb });
      const user = await createUser(testDb.client, { namespace: "acme" });
      const bundle = await createBundle(testDb.client, {
        namespace: "acme",
        name: "my-agent",
      });
      const digest = sha256("blob-content");
      const storageKey = `blobs/${digest}`;

      // Insert blob into DB and mock storage
      await testDb.client.query(
        `INSERT INTO blobs (digest, size, media_type, storage_key)
         VALUES ($1, $2, $3, $4)`,
        [digest, 12, "application/octet-stream", storageKey],
      );
      await app.storage.put(storageKey, Buffer.from("blob-content"));

      // Create a bundle version referencing this blob so the bundle lookup succeeds
      await createBundleVersion(testDb.client, bundle.id, {
        version: "v1.0.0",
        digest,
        manifestJson: {
          schemaVersion: 2,
          layers: [{ digest, size: 12, mediaType: "application/octet-stream" }],
          config: { digest, size: 12, mediaType: "application/vnd.oci.image.config.v1+json" },
        },
        size: 100,
      });

      // Fire 10 rapid requests from the same IP
      for (let i = 0; i < 10; i++) {
        const res = await app.inject({
          method: "GET",
          url: `/v2/acme/my-agent/blobs/${digest}`,
        });
        expect(res.statusCode).toBe(200);
      }

      // Verify only one pull_stats row was created
      const statsResult = await testDb.client.query(
        `SELECT count FROM pull_stats WHERE bundle_id = $1`,
        [bundle.id],
      );
      expect(statsResult.rows.length).toBeLessThanOrEqual(1);
      if (statsResult.rows.length === 1) {
        // The first request should have created the row with count=1;
        // onConflictDoUpdate would increment if unthrottled, but throttle prevents that.
        expect(statsResult.rows[0].count).toBe(1);
      }

      // Verify bundle pullCount was incremented only once
      const bundleResult = await testDb.client.query(
        `SELECT pull_count FROM bundles WHERE id = $1`,
        [bundle.id],
      );
      expect(bundleResult.rows[0].pull_count).toBe(1);
    });
  });
});
