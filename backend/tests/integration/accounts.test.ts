import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createTestDb, resetTables } from "../fixtures/db.js";
import { buildTestApp } from "../fixtures/app.js";
import { createBundle, createInstance, createUser } from "../fixtures/factories.js";
import { createAuthenticatedUser } from "../fixtures/auth.js";
import type { TestDb } from "../fixtures/db.js";
import {
  findOrCreateUser,
  handleCandidate,
  handleFromName,
  handleProblem,
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

// ─────────────────────────────────────────────────────────────────────────────
// After first sign-in the person keeps the suggested handle or picks another.
// It can change until a seed or a public peko carries it.
// ─────────────────────────────────────────────────────────────────────────────

describe("handleProblem", () => {
  it.each([
    ["alice", null],
    ["a1", null],
    ["al_ice-2", null],
    ["a", "invalid"],
    ["Alice", "invalid"],
    ["-alice", "invalid"],
    ["alice-", "invalid"],
    ["al.ice", "invalid"],
    ["a".repeat(40), "invalid"],
    ["auth", "reserved"],
    ["seeds", "reserved"],
    ["pekohub", "reserved"],
  ])("%s → %s", (handle, problem) => {
    expect(handleProblem(handle)).toBe(problem);
  });

  it("first sign-in never hands out a reserved handle", async () => {
    const testDb = await createTestDb();
    const app = await buildTestApp({ testDb });
    try {
      const user = await findOrCreateUser({
        externalId: "github:42",
        provider: "github",
        suggestedHandle: "Admin",
        displayName: "Admin",
      });
      expect(user.namespace).toBe("admin-2");
      expect(user.handleChosenAt).toBeNull();
    } finally {
      await app.close();
      await testDb.client.close();
    }
  });
});

describe("choosing a handle", () => {
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

  const me = async (headers: Record<string, string>) =>
    JSON.parse((await app.inject({ method: "GET", url: "/v1/auth/me", headers })).payload);
  const choose = (headers: Record<string, string>, handle: unknown) =>
    app.inject({ method: "PUT", url: "/v1/auth/handle", headers, payload: { handle } });

  it("a new account has not chosen yet, and its handle can change", async () => {
    const { headers } = await createAuthenticatedUser(testDb.client, { namespace: "john-smith1987" });

    expect(await me(headers)).toMatchObject({
      namespace: "john-smith1987",
      handleChosen: false,
      handleLocked: false,
    });
  });

  it("changes the handle, and the account is found by the new one", async () => {
    const { headers } = await createAuthenticatedUser(testDb.client, { namespace: "john-smith1987" });

    const response = await choose(headers, "@John");

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body).toMatchObject({ namespace: "john", handleChosen: true });
    expect(typeof body.token).toBe("string");
    expect(await me(headers)).toMatchObject({ namespace: "john", handleChosen: true });
    const page = await app.inject({ method: "GET", url: "/v1/people/john" });
    expect(page.statusCode).toBe(200);
    const old = await app.inject({ method: "GET", url: "/v1/people/john-smith1987" });
    expect(old.statusCode).toBe(404);
  });

  it("keeping the suggested handle confirms it", async () => {
    const { headers } = await createAuthenticatedUser(testDb.client, { namespace: "sam" });

    const response = await choose(headers, "sam");

    expect(response.statusCode).toBe(200);
    expect(await me(headers)).toMatchObject({ namespace: "sam", handleChosen: true });
  });

  it("refuses a handle someone else has, a reserved one, and a malformed one", async () => {
    await createUser(testDb.client, { namespace: "alice" });
    const { headers } = await createAuthenticatedUser(testDb.client, { namespace: "alice-2" });

    const taken = await choose(headers, "alice");
    const reserved = await choose(headers, "admin");
    const invalid = await choose(headers, "al ice");
    const missing = await choose(headers, 42);

    expect([taken.statusCode, JSON.parse(taken.payload).code]).toEqual([409, "taken"]);
    expect([reserved.statusCode, JSON.parse(reserved.payload).code]).toEqual([400, "reserved"]);
    expect([invalid.statusCode, JSON.parse(invalid.payload).code]).toEqual([400, "invalid"]);
    expect(missing.statusCode).toBe(400);
    expect((await me(headers)).namespace).toBe("alice-2");
  });

  it("says whether a handle is free, counting your own as free", async () => {
    await createUser(testDb.client, { namespace: "alice" });
    const { headers } = await createAuthenticatedUser(testDb.client, { namespace: "bob" });
    const check = async (handle: string) =>
      JSON.parse(
        (await app.inject({ method: "GET", url: `/v1/auth/handle/${encodeURIComponent(handle)}`, headers }))
          .payload,
      );

    expect(await check("alice")).toEqual({ handle: "alice", available: false, reason: "taken" });
    expect(await check("bob")).toEqual({ handle: "bob", available: true });
    expect(await check("@Carol")).toEqual({ handle: "carol", available: true });
    expect(await check("api")).toEqual({ handle: "api", available: false, reason: "reserved" });
    const anonymous = await app.inject({ method: "GET", url: "/v1/auth/handle/carol" });
    expect(anonymous.statusCode).toBe(401);
  });

  it("a published seed fixes the handle", async () => {
    const { user, headers } = await createAuthenticatedUser(testDb.client, { namespace: "alice" });
    await createBundle(testDb.client, { namespace: "alice", name: "ada" });

    expect((await me(headers)).handleLocked).toBe(true);
    const response = await choose(headers, "alicia");
    expect([response.statusCode, JSON.parse(response.payload).code]).toEqual([409, "locked"]);
    // Keeping it still confirms it.
    expect((await choose(headers, "alice")).statusCode).toBe(200);
    expect(user.namespace).toBe("alice");
  });

  it("a public peko fixes the handle; a private one does not", async () => {
    const { user, headers } = await createAuthenticatedUser(testDb.client, { namespace: "alice" });
    await createInstance(testDb.client, {
      ownerSubject: { kind: "user", id: user.id },
      name: "quiet",
      exposure: "private",
    });
    expect((await me(headers)).handleLocked).toBe(false);

    await createInstance(testDb.client, {
      ownerSubject: { kind: "user", id: user.id },
      name: "ada",
      exposure: "public",
    });

    expect((await me(headers)).handleLocked).toBe(true);
    expect((await choose(headers, "alicia")).statusCode).toBe(409);
  });
});
