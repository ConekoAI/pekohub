import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createTestDb, resetTables } from "../fixtures/db.js";
import { buildTestApp } from "../fixtures/app.js";
import { createUser, createBundle } from "../fixtures/factories.js";
import { authHeaders } from "../fixtures/auth.js";
import type { TestDb } from "../fixtures/db.js";
import crypto from "node:crypto";

/**
 * ADR-056 seed push/pull end-to-end, mirroring the runtime's exact
 * wire sequence (peko-rs/core/src/registry/client.rs `push_principal` /
 * `pull`) against the multi-segment repo `peko/principals/<name>`:
 *
 *   HEAD blob (404) → POST uploads (401 anon / 202 authed) →
 *   PUT blob ?digest= → PUT zero-layer manifest (config media type
 *   `application/vnd.peko.config.v1+json`, NO `dev.pekohub.bundleType`
 *   annotation — only `org.peko.kind:"principal"` +
 *   `dev.pekohub.principalName`) → GET manifest by tag + `latest` →
 *   GET blob.
 *
 * Plus the publisher model (ADR-056): different-user overwrite → 403,
 * same publisher new version → 201, legacy NULL-publisher claim, and
 * every retired artifact kind (`extension` / `agent` / `team`) → 410,
 * and the retired `peko/{extensions,agents,teams}/` lanes → 410.
 */

function sha256(buffer: Buffer | string): string {
  return "sha256:" + crypto.createHash("sha256").update(buffer).digest("hex");
}

const REPO = "peko/principals/assistant";

/** The stripped principal.toml the runtime ships as the config blob. */
const SEED_TOML = '[principal]\nname = "assistant"\n';

function seedManifest(configDigest: string, version: string) {
  return {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: {
      mediaType: "application/vnd.peko.config.v1+json",
      digest: configDigest,
      size: Buffer.byteLength(SEED_TOML),
    },
    layers: [],
    annotations: {
      "org.peko.name": "assistant",
      "org.peko.version": version,
      "org.peko.kind": "principal",
      "dev.pekohub.principalName": "assistant",
    },
  };
}

async function uploadBlob(
  app: Awaited<ReturnType<typeof buildTestApp>>,
  headers: { Authorization: string },
  content: string,
): Promise<string> {
  const digest = sha256(content);
  const init = await app.inject({
    method: "POST",
    url: `/v2/${REPO}/blobs/uploads/`,
    headers,
  });
  expect(init.statusCode).toBe(202);
  const location = init.headers.location as string;
  expect(location).toMatch(
    /^\/v2\/peko\/principals\/assistant\/blobs\/uploads\/[\w-]+$/,
  );

  const put = await app.inject({
    method: "PUT",
    url: `${location}?digest=${digest}`,
    headers: { ...headers, "content-type": "application/octet-stream" },
    payload: Buffer.from(content),
  });
  expect(put.statusCode).toBe(201);
  expect(put.headers["docker-content-digest"]).toBe(digest);
  return digest;
}

describe("ADR-056 seed push/pull (peko/principals/<name>)", () => {
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

  it("runs the full runtime push → pull sequence against a multi-segment repo", async () => {
    const app = await buildTestApp({ testDb });
    const alice = await createUser(testDb.client, { namespace: "alice" });
    const headers = await authHeaders(alice);
    const configDigest = sha256(SEED_TOML);

    // 1. Runtime mount check: HEAD blob → 404 (blob not on the hub yet)
    const head = await app.inject({
      method: "HEAD",
      url: `/v2/${REPO}/blobs/${configDigest}`,
    });
    expect(head.statusCode).toBe(404);

    // 2. Upload initiation requires auth (the runtime always sends
    //    `Authorization: Bearer <pkr_ key>` — anonymous callers get 401)
    const anonInit = await app.inject({
      method: "POST",
      url: `/v2/${REPO}/blobs/uploads/`,
    });
    expect(anonInit.statusCode).toBe(401);

    const anonPut = await app.inject({
      method: "PUT",
      url: `/v2/${REPO}/blobs/uploads/123e4567-e89b-12d3-a456-426614174000?digest=${configDigest}`,
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from(SEED_TOML),
    });
    expect(anonPut.statusCode).toBe(401);

    // 3. Blob upload with auth
    await uploadBlob(app, headers, SEED_TOML);

    // 4. Zero-layer seed manifest PUT — annotations carry
    //    `org.peko.kind: "principal"` and NO `dev.pekohub.bundleType`
    const manifest = seedManifest(configDigest, "1.0.0");
    const manifestPut = await app.inject({
      method: "PUT",
      url: `/v2/${REPO}/manifests/1.0.0`,
      headers: {
        ...headers,
        "content-type": "application/vnd.oci.image.manifest.v1+json",
      },
      payload: JSON.stringify(manifest),
    });
    expect(manifestPut.statusCode).toBe(201);
    const manifestDigest = manifestPut.headers["docker-content-digest"];
    expect(manifestDigest).toBe(sha256(JSON.stringify(manifest)));

    // Bundle row: kind-derived bundleType + publisher ownership
    const bundleRows = await testDb.client.query(
      `SELECT bundle_type, publisher_id FROM bundles WHERE namespace = 'peko/principals' AND name = 'assistant'`,
    );
    expect(bundleRows.rows).toHaveLength(1);
    expect(bundleRows.rows[0].bundle_type).toBe("principal");
    expect(bundleRows.rows[0].publisher_id).toBe(alice.id);

    // 5. Pull side: GET manifest by tag, by `latest`, and by digest
    for (const ref of ["1.0.0", "latest", manifestDigest as string]) {
      const get = await app.inject({
        method: "GET",
        url: `/v2/${REPO}/manifests/${ref}`,
      });
      expect(get.statusCode).toBe(200);
      expect(JSON.parse(get.body)).toEqual(manifest);
      expect(get.headers["docker-content-digest"]).toBe(manifestDigest);
    }

    // 6. Pull side: GET blob returns the seed TOML verbatim
    const blobGet = await app.inject({
      method: "GET",
      url: `/v2/${REPO}/blobs/${configDigest}`,
    });
    expect(blobGet.statusCode).toBe(200);
    expect(blobGet.body).toBe(SEED_TOML);

    // 7. Multi-segment tags/list + catalog carry the full repo path
    const tags = await app.inject({
      method: "GET",
      url: `/v2/${REPO}/tags/list`,
    });
    expect(tags.statusCode).toBe(200);
    expect(JSON.parse(tags.body)).toEqual({
      name: "peko/principals/assistant",
      tags: ["1.0.0"],
    });

    const catalog = await app.inject({ method: "GET", url: "/v2/_catalog" });
    expect(catalog.statusCode).toBe(200);
    expect(JSON.parse(catalog.body).repositories).toContain(
      "peko/principals/assistant",
    );
  });

  it("rejects a different user's overwrite (403) and accepts the publisher's new version (201)", async () => {
    const app = await buildTestApp({ testDb });
    const alice = await createUser(testDb.client, { namespace: "alice" });
    const bob = await createUser(testDb.client, { namespace: "bob" });
    const aliceHeaders = await authHeaders(alice);
    const bobHeaders = await authHeaders(bob);
    const configDigest = await uploadBlob(app, aliceHeaders, SEED_TOML);

    const v1 = await app.inject({
      method: "PUT",
      url: `/v2/${REPO}/manifests/1.0.0`,
      headers: {
        ...aliceHeaders,
        "content-type": "application/vnd.oci.image.manifest.v1+json",
      },
      payload: JSON.stringify(seedManifest(configDigest, "1.0.0")),
    });
    expect(v1.statusCode).toBe(201);

    // Bob is not the publisher — even a NEW version is denied
    const bobPush = await app.inject({
      method: "PUT",
      url: `/v2/${REPO}/manifests/2.0.0`,
      headers: {
        ...bobHeaders,
        "content-type": "application/vnd.oci.image.manifest.v1+json",
      },
      payload: JSON.stringify(seedManifest(configDigest, "2.0.0")),
    });
    expect(bobPush.statusCode).toBe(403);
    expect(JSON.parse(bobPush.body).errors[0].code).toBe("DENIED");

    // The publisher pushes the next version
    const v2 = await app.inject({
      method: "PUT",
      url: `/v2/${REPO}/manifests/2.0.0`,
      headers: {
        ...aliceHeaders,
        "content-type": "application/vnd.oci.image.manifest.v1+json",
      },
      payload: JSON.stringify(seedManifest(configDigest, "2.0.0")),
    });
    expect(v2.statusCode).toBe(201);

    // `latest` now resolves to 2.0.0
    const latest = await app.inject({
      method: "GET",
      url: `/v2/${REPO}/manifests/latest`,
    });
    expect(latest.statusCode).toBe(200);
    expect(JSON.parse(latest.body).annotations["org.peko.version"]).toBe(
      "2.0.0",
    );
  });

  it("rejects squatting on another user's single-segment namespace", async () => {
    const app = await buildTestApp({ testDb });
    await createUser(testDb.client, { namespace: "alice" });
    const bob = await createUser(testDb.client, { namespace: "bob" });
    const bobHeaders = await authHeaders(bob);
    const configDigest = await uploadBlob(app, bobHeaders, SEED_TOML);

    const res = await app.inject({
      method: "PUT",
      url: `/v2/alice/assistant/manifests/1.0.0`,
      headers: {
        ...bobHeaders,
        "content-type": "application/vnd.oci.image.manifest.v1+json",
      },
      payload: JSON.stringify(seedManifest(configDigest, "1.0.0")),
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects every artifact kind except 'principal' with 410", async () => {
    const app = await buildTestApp({ testDb });
    const alice = await createUser(testDb.client, { namespace: "alice" });
    const headers = await authHeaders(alice);
    const configDigest = await uploadBlob(app, headers, SEED_TOML);

    // The current annotation. `extension` is retired (capabilities are
    // workspace files — ADR-047 §5 / ADR-050); `agent`/`team` went with
    // ADR-041. All are 410, never silently re-typed as `principal`.
    for (const kind of ["extension", "agent", "team"]) {
      const res = await app.inject({
        method: "PUT",
        url: `/v2/peko/principals/kind-${kind}/manifests/1.0.0`,
        headers: {
          ...headers,
          "content-type": "application/vnd.oci.image.manifest.v1+json",
        },
        payload: JSON.stringify({
          ...seedManifest(configDigest, "1.0.0"),
          annotations: { "org.peko.kind": kind },
        }),
      });
      expect(res.statusCode).toBe(410);
      expect(JSON.parse(res.body).error).toContain("seed-only");
    }

    // The hub's own older annotation is still read as a rejection guard,
    // so an old client gets an explicit error rather than a silent
    // re-type.
    const explicit = await app.inject({
      method: "PUT",
      url: `/v2/peko/principals/old-agent/manifests/1.0.0`,
      headers: {
        ...headers,
        "content-type": "application/vnd.oci.image.manifest.v1+json",
      },
      payload: JSON.stringify({
        ...seedManifest(configDigest, "1.0.0"),
        annotations: { "dev.pekohub.bundleType": "agent" },
      }),
    });
    expect(explicit.statusCode).toBe(410);
  });

  it("refuses new pushes into retired repo lanes (410)", async () => {
    const app = await buildTestApp({ testDb });
    const alice = await createUser(testDb.client, { namespace: "alice" });
    const headers = await authHeaders(alice);
    const configDigest = await uploadBlob(app, headers, SEED_TOML);

    // `peko/extensions/…`, `peko/agents/…` and `peko/teams/…` distributed
    // capability packages and `.agent` bundles (ADR-037 / ADR-047 §5 /
    // ADR-050). Existing legacy rows stay readable and deletable — only
    // growth is refused, so residue cannot accumulate.
    for (const lane of ["extensions", "agents", "teams"]) {
      const res = await app.inject({
        method: "PUT",
        url: `/v2/peko/${lane}/legacy-thing/manifests/1.0.0`,
        headers: {
          ...headers,
          "content-type": "application/vnd.oci.image.manifest.v1+json",
        },
        payload: JSON.stringify(seedManifest(configDigest, "1.0.0")),
      });
      expect(res.statusCode).toBe(410);
      expect(JSON.parse(res.body).error).toContain("retired");
    }

    // The seed lane still accepts the same push.
    const ok = await app.inject({
      method: "PUT",
      url: `/v2/peko/principals/legacy-thing/manifests/1.0.0`,
      headers: {
        ...headers,
        "content-type": "application/vnd.oci.image.manifest.v1+json",
      },
      payload: JSON.stringify(seedManifest(configDigest, "1.0.0")),
    });
    expect(ok.statusCode).toBe(201);
  });

  it("lets the namespace-matching pusher claim a legacy NULL-publisher bundle", async () => {
    const app = await buildTestApp({ testDb });
    const alice = await createUser(testDb.client, { namespace: "alice" });
    const bob = await createUser(testDb.client, { namespace: "bob" });
    const aliceHeaders = await authHeaders(alice);
    const bobHeaders = await authHeaders(bob);
    const configDigest = await uploadBlob(app, aliceHeaders, SEED_TOML);

    // Legacy row: no publisher recorded (pre-ADR-056)
    await createBundle(testDb.client, {
      namespace: "alice",
      name: "legacy-pkg",
      publisherId: null,
    });

    // Bob can neither push to nor claim it
    const bobPush = await app.inject({
      method: "PUT",
      url: `/v2/alice/legacy-pkg/manifests/1.0.0`,
      headers: {
        ...bobHeaders,
        "content-type": "application/vnd.oci.image.manifest.v1+json",
      },
      payload: JSON.stringify(seedManifest(configDigest, "1.0.0")),
    });
    expect(bobPush.statusCode).toBe(403);

    // Alice (namespace match) claims it on push
    const alicePush = await app.inject({
      method: "PUT",
      url: `/v2/alice/legacy-pkg/manifests/1.0.0`,
      headers: {
        ...aliceHeaders,
        "content-type": "application/vnd.oci.image.manifest.v1+json",
      },
      payload: JSON.stringify(seedManifest(configDigest, "1.0.0")),
    });
    expect(alicePush.statusCode).toBe(201);

    const rows = await testDb.client.query(
      `SELECT publisher_id FROM bundles WHERE namespace = 'alice' AND name = 'legacy-pkg'`,
    );
    expect(rows.rows[0].publisher_id).toBe(alice.id);
  });

  it("serves the CLI-facing /api/v1 surface (search, bundle detail, OAuth)", async () => {
    const app = await buildTestApp({ testDb, enableOAuth: true });
    const alice = await createUser(testDb.client, { namespace: "alice" });
    const headers = await authHeaders(alice);
    const configDigest = await uploadBlob(app, headers, SEED_TOML);

    const put = await app.inject({
      method: "PUT",
      url: `/v2/${REPO}/manifests/1.0.0`,
      headers: {
        ...headers,
        "content-type": "application/vnd.oci.image.manifest.v1+json",
      },
      payload: JSON.stringify(seedManifest(configDigest, "1.0.0")),
    });
    expect(put.statusCode).toBe(201);

    // `peko search` hits /api/v1/search
    const search = await app.inject({
      method: "GET",
      url: "/api/v1/search?q=assistant&page=1&perPage=20",
    });
    expect(search.statusCode).toBe(200);
    const searchBody = JSON.parse(search.body);
    expect(searchBody).toHaveProperty("items");

    // Bundle detail with a multi-segment namespace
    const detail = await app.inject({
      method: "GET",
      url: "/api/v1/bundles/peko/principals/assistant",
    });
    expect(detail.statusCode).toBe(200);
    const detailBody = JSON.parse(detail.body);
    expect(detailBody.namespace).toBe("peko/principals");
    expect(detailBody.name).toBe("assistant");
    expect(detailBody.versions[0].version).toBe("1.0.0");
    // `peko pull <host>/<repo>:<tag>` — bare name:tag only works
    // against a configured default registry
    expect(detailBody.installCommand).toMatch(
      /^peko pull .+\/peko\/principals\/assistant:1\.0\.0$/,
    );

    // Versions endpoint, multi-segment
    const versions = await app.inject({
      method: "GET",
      url: "/api/v1/bundles/peko/principals/assistant/versions",
    });
    expect(versions.statusCode).toBe(200);
    expect(JSON.parse(versions.body).versions).toHaveLength(1);

    // The same detail is reachable on the canonical /v1 prefix too
    const v1Detail = await app.inject({
      method: "GET",
      url: "/v1/bundles/peko/principals/assistant",
    });
    expect(v1Detail.statusCode).toBe(200);

    // OAuth login entry point used by the CLI
    const authorize = await app.inject({
      method: "GET",
      url: "/api/v1/auth/github/authorize",
    });
    expect(authorize.statusCode).toBe(302);
    expect(authorize.headers.location).toContain("github.com");
  });
});
