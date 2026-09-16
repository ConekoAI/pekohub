import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import {
  readOrSetVisitor,
  signVisitorId,
  VISITOR_COOKIE,
} from "../../src/services/visitor-cookie.js";

const SECRET = "test-secret-key-that-is-32-chars-long!!";
const OTHER_SECRET = "another-secret-key-that-is-32-chars!!";

async function buildApp(secret: string = SECRET) {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  app.get("/probe", async (req, reply) => {
    const id = readOrSetVisitor(req, reply, secret);
    return { id };
  });
  return app;
}

/** Extract the pekohub_visitor cookie value from an inject response. */
function visitorCookieValue(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers["set-cookie"];
  const header = Array.isArray(raw) ? raw[0] : raw;
  expect(typeof header).toBe("string");
  const match = (header as string).match(new RegExp(`^${VISITOR_COOKIE}=([^;]+)`));
  expect(match).not.toBeNull();
  return match![1];
}

describe("visitor-cookie (ADR-058 D5)", () => {
  it("mints a signed v1 cookie when no cookie is present", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/probe" });
    const { id } = JSON.parse(response.payload);

    expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    const value = visitorCookieValue(response);
    expect(value).toBe(signVisitorId(id, SECRET));
    // Whole cookie value stays well under the 128-char budget.
    expect(value.length).toBeLessThanOrEqual(128);
  });

  it("round-trips a valid signed cookie (same id returned)", async () => {
    const app = await buildApp();
    const first = await app.inject({ method: "GET", url: "/probe" });
    const firstId = JSON.parse(first.payload).id;
    const cookieValue = visitorCookieValue(first);

    const second = await app.inject({
      method: "GET",
      url: "/probe",
      headers: { cookie: `${VISITOR_COOKIE}=${cookieValue}` },
    });
    expect(JSON.parse(second.payload).id).toBe(firstId);
  });

  it.each([
    ["a victim's hub UUID", "b3b7c5e2-9f7b-4b1e-9b3a-2f3b7c5e29f7"],
    ["a principal DID", "principal:did:key:z6MkrJVnaZkeF8QyTZuNb6vQvVhGHCbUvJqeEv7m1Fje5xJi"],
    ["the literal 'local'", "local"],
  ])("rejects a forged cookie containing %s and mints a fresh id", async (_label, forged) => {
    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/probe",
      headers: { cookie: `${VISITOR_COOKIE}=${forged}` },
    });
    const { id } = JSON.parse(response.payload);

    // The forged value must NOT be adopted — a fresh hub-minted id
    // is issued and the cookie is overwritten with its signature.
    expect(id).not.toBe(forged);
    expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(visitorCookieValue(response)).toBe(signVisitorId(id, SECRET));
  });

  it("rejects a v1-shaped cookie with a bad HMAC", async () => {
    const app = await buildApp();
    const victimId = "b3b7c5e2-9f7b-4b1e-9b3a-2f3b7c5e29f7";
    const forged = `v1.${victimId}.${Buffer.from("forged-forged-forged-forged-12").toString("base64url")}`;
    const response = await app.inject({
      method: "GET",
      url: "/probe",
      headers: { cookie: `${VISITOR_COOKIE}=${forged}` },
    });
    const { id } = JSON.parse(response.payload);
    expect(id).not.toBe(victimId);
  });

  it("rejects a cookie signed with a different secret", async () => {
    const app = await buildApp();
    const foreignId = "b3b7c5e2-9f7b-4b1e-9b3a-2f3b7c5e29f7";
    const foreignCookie = signVisitorId(foreignId, OTHER_SECRET);
    const response = await app.inject({
      method: "GET",
      url: "/probe",
      headers: { cookie: `${VISITOR_COOKIE}=${foreignCookie}` },
    });
    expect(JSON.parse(response.payload).id).not.toBe(foreignId);
  });

  it("rejects an over-long cookie value", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/probe",
      headers: { cookie: `${VISITOR_COOKIE}=${"a".repeat(200)}` },
    });
    const { id } = JSON.parse(response.payload);
    expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });
});
