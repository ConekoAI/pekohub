import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createTestDb, resetTables } from "../fixtures/db.js";
import { buildTestApp } from "../fixtures/app.js";
import { createUser } from "../fixtures/factories.js";
import type { TestDb } from "../fixtures/db.js";
import {
  findOrCreateUser,
  handleCandidate,
  handleFromName,
} from "../../src/services/accounts.js";
import { parseHubRef } from "@pekohub/shared";

// ─────────────────────────────────────────────────────────────────────────────
// First sign-in makes an account with a handle that is valid (hub ADR-009:
// lowercase, found by `@handle`) and free — never a 500 because someone on
// the other provider already has that name.
// ─────────────────────────────────────────────────────────────────────────────

describe("handleFromName", () => {
  it.each([
    ["alice", "alice"],
    ["Alice-Smith", "alice-smith"],
    ["john.doe+tag", "john-doe-tag"],
    ["__x__", "x"],
    ["Ünïcode", "n-code"],
    ["...", "user"],
    ["a".repeat(60), "a".repeat(39)],
  ])("%s → %s", (raw, handle) => {
    expect(handleFromName(raw)).toBe(handle);
  });

  it("always yields an ID the parser reads back", () => {
    for (const raw of ["Bob", "x.y.z", "-lead", "9lives", "名前", "a_b-"]) {
      const handle = handleFromName(raw);
      expect(parseHubRef(`@${handle}`)).toEqual({ kind: "person", handle });
    }
  });

  it("numbers taken handles within the length limit", () => {
    expect(handleCandidate("alice", 1)).toBe("alice");
    expect(handleCandidate("alice", 2)).toBe("alice-2");
    expect(handleCandidate("a".repeat(39), 12)).toBe(`${"a".repeat(36)}-12`);
  });
});

describe("findOrCreateUser", () => {
  let testDb: TestDb;
  let app: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    testDb = await createTestDb();
    app = await buildTestApp({ testDb });
  });

  beforeEach(async () => {
    await resetTables(testDb.client);
  });

  afterAll(async () => {
    await app.close();
    await testDb.client.close();
  });

  const profile = (externalId: string, suggestedHandle: string) => ({
    externalId,
    provider: externalId.split(":")[0],
    suggestedHandle,
    displayName: suggestedHandle,
  });

  it("gives the next free handle when the name is taken", async () => {
    await createUser(testDb.client, { namespace: "john", provider: "github" });
    await createUser(testDb.client, { namespace: "john-2", provider: "github" });

    const user = await findOrCreateUser(profile("google:123", "John"));

    expect(user.namespace).toBe("john-3");
  });

  it("returns the same account on the next sign-in", async () => {
    const first = await findOrCreateUser(profile("github:7", "Octo.Cat"));
    const again = await findOrCreateUser(profile("github:7", "renamed"));

    expect(first.namespace).toBe("octo-cat");
    expect(again.id).toBe(first.id);
    expect(again.namespace).toBe("octo-cat");
  });

  it("survives two first sign-ins wanting one handle at once", async () => {
    const [a, b] = await Promise.all([
      findOrCreateUser(profile("github:1", "sam")),
      findOrCreateUser(profile("google:1", "sam")),
    ]);

    expect(new Set([a.namespace, b.namespace])).toEqual(new Set(["sam", "sam-2"]));
  });
});
