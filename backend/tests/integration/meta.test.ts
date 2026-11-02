import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createTestDb, resetTables } from "../fixtures/db.js";
import { buildTestApp } from "../fixtures/app.js";
import { createUser, createInstance } from "../fixtures/factories.js";
import { authHeaders } from "../fixtures/auth.js";
import type { TestDb } from "../fixtures/db.js";

// Gap map C3/C4: the API and the website live on different origins, so
// the Hub says where each is and builds share links on the website.

describe("Hub origins", () => {
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

  it("GET /v1/meta names the API origin, the tunnel, and the website", async () => {
    process.env.PUBLIC_ORIGIN = "https://api.hub.test";
    process.env.FRONTEND_URL = "https://hub.test";
    try {
      const app = await buildTestApp({ testDb });
      const res = await app.inject({ method: "GET", url: "/v1/meta" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        apiOrigin: "https://api.hub.test",
        webOrigin: "https://hub.test",
        tunnelUrl: "wss://api.hub.test/v1/tunnel",
        pages: {
          person: "https://hub.test/@{owner}",
          peko: "https://hub.test/@{owner}/{name}",
          seed: "https://hub.test/{owner}/{name}",
        },
      });
    } finally {
      delete process.env.PUBLIC_ORIGIN;
      delete process.env.FRONTEND_URL;
    }
  });

  it("a public peko's directory answer carries its share link on the website", async () => {
    process.env.FRONTEND_URL = "https://hub.test";
    try {
      const app = await buildTestApp({ testDb });
      const owner = await createUser(testDb.client, { namespace: "alice" });
      const instance = await createInstance(testDb.client, {
        ownerSubject: { kind: "user", id: String(owner.id) },
        name: "helper",
        exposure: "public",
        principalDid: "did:peko:principal:abc",
      });
      const res = await app.inject({
        method: "GET",
        url: `/v1/principals/by-hub-id/${instance.hubId}`,
        headers: await authHeaders(owner),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().shareUrl).toBe("https://hub.test/@alice/helper");
    } finally {
      delete process.env.FRONTEND_URL;
    }
  });
});
