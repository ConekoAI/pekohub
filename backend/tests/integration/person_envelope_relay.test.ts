/**
 * Runtime ADR-090 D3: a person has no signing key, so an envelope that
 * speaks for one (`sourcePrincipalDid = user:hub:<account>`) is vouched
 * for by the runtime that sends it — and the Hub relays it only from the
 * runtime registered to that account.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import Fastify from "fastify";
import cookie from "@fastify/cookie";

import { createTestDb, resetTables } from "../fixtures/db.js";
import { createUser } from "../fixtures/factories.js";
import { MockWebSocket, completeHandshake, makeRuntimeIdentity, seedRuntime } from "../fixtures/tunnel.js";
import configPlugin from "../../src/plugins/config.js";
import authPlugin from "../../src/plugins/auth.js";
import { setDb } from "../../src/db/index.js";
import { TunnelManager } from "../../src/services/tunnel-manager.js";
import { metrics, CounterName } from "../../src/services/metrics.js";
import type { TestDb } from "../fixtures/db.js";

async function buildManager(testDb: TestDb) {
  const originalEnv = { ...process.env };
  Object.assign(process.env, {
    DATABASE_URL: "postgres://localhost:5432/pekohub_test",
    S3_ENDPOINT: "http://localhost:9000",
    S3_ACCESS_KEY: "test",
    S3_SECRET_KEY: "test",
    MEILISEARCH_URL: "http://localhost:7700",
    MEILISEARCH_API_KEY: "test",
    JWT_SECRET: "test-secret-key-that-is-32-chars-long!!",
    NODE_ENV: "test",
  });
  setDb(testDb.db);
  const app = Fastify({ logger: false });
  await app.register(configPlugin);
  await app.register(cookie);
  await app.register(authPlugin);
  const tunnelManager = new TunnelManager(app);
  process.env = originalEnv;
  return tunnelManager;
}

const flush = () => new Promise((r) => setTimeout(r, 30));

describe("Relaying a person's envelopes (runtime ADR-090 D3)", () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  });

  beforeEach(async () => {
    await resetTables(testDb.client);
    metrics.reset();
  });

  afterAll(async () => {
    await testDb.client.close();
  });

  /** Alice's runtime A and Bob's runtime B, both connected. */
  async function twoRuntimes() {
    const manager = await buildManager(testDb);
    const alice = await createUser(testDb.client, { namespace: "alice" });
    const bob = await createUser(testDb.client, { namespace: "bob" });
    const idA = makeRuntimeIdentity();
    const idB = makeRuntimeIdentity();
    await seedRuntime(testDb, idA.did, alice.id);
    await seedRuntime(testDb, idB.did, bob.id);
    const socketA = new MockWebSocket();
    const socketB = new MockWebSocket();
    manager.handleSocket(socketA.asWebSocket());
    manager.handleSocket(socketB.asWebSocket());
    await completeHandshake(socketA, idA.did, idA.privateKey);
    await completeHandshake(socketB, idB.did, idB.privateKey);
    return { alice, bob, idA, idB, socketA, socketB };
  }

  const invite = (source: string, from: string, to: string) => ({
    type: "tunnel_channel_invite" as const,
    requestId: `inv-${source}`,
    sourceRuntimeId: from,
    recipientRuntimeId: to,
    sourcePrincipalDid: source,
    channelId: "dm_abc",
    creator: source,
    creatorDid: source,
    name: "dm",
    kind: "dm",
    initialMembers: [source, "principal:hub:6f1c2a52-58b6-4b8e-9d1c-6a3f0b6f1a01"],
    signature: "runtime-sig",
  });

  const post = (source: string, from: string, to: string) => ({
    type: "tunnel_channel_event" as const,
    requestId: `evt-${source}`,
    sourceRuntimeId: from,
    recipientRuntimeId: to,
    sourcePrincipalDid: source,
    channelId: "dm_abc",
    event: { kind: "posted", channel: "dm_abc", author: source, parent: null, text: "hi", at: "2026-11-01T10:00:00Z" },
    signature: "runtime-sig",
  });

  it("relays a person's invite and posts from the runtime registered to their account", async () => {
    const { alice, idA, idB, socketA, socketB } = await twoRuntimes();
    const me = `user:hub:${alice.id}`;
    socketA.triggerMessage(invite(me, idA.did, idB.did));
    socketA.triggerMessage(post(me, idA.did, idB.did));
    await flush();
    expect(socketB.sent.filter((m) => m.type === "tunnel_channel_invite")).toHaveLength(1);
    expect(socketB.sent.filter((m) => m.type === "tunnel_channel_event")).toHaveLength(1);
  });

  it("drops envelopes speaking for another account's person, and keeps the tunnel", async () => {
    const { bob, idA, idB, socketA, socketB } = await twoRuntimes();
    const impersonated = `user:hub:${bob.id}`;
    socketA.triggerMessage(invite(impersonated, idA.did, idB.did));
    socketA.triggerMessage(post(impersonated, idA.did, idB.did));
    await flush();
    expect(socketB.sent.filter((m) => m.type === "tunnel_channel_invite")).toHaveLength(0);
    expect(socketB.sent.filter((m) => m.type === "tunnel_channel_event")).toHaveLength(0);
    const counts = metrics.snapshot();
    expect(counts[CounterName.HubChannelInviteRejectedPersonAccount]).toBe(1);
    expect(counts[CounterName.HubChannelEventRejectedPersonAccount]).toBe(1);
    // A's tunnel stays up: this is a refused envelope, not an impersonated runtime.
    expect(socketA.closed).toBeFalsy();
  });

  it("leaves non-person sources to the existing checks", async () => {
    const { idA, idB, socketA, socketB } = await twoRuntimes();
    socketA.triggerMessage(post("prin_alice", idA.did, idB.did));
    await flush();
    expect(socketB.sent.filter((m) => m.type === "tunnel_channel_event")).toHaveLength(1);
  });
});
