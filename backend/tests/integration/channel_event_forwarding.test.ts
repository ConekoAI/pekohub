/**
 * Cross-runtime channel event forwarding (peko-channel cross-runtime PR-C).
 *
 * Mirrors `principal_forwarding.test.ts` shape but trimmed: channel
 * events are push-only (no request/response), so the test surface is
 * smaller. Pin to the acceptance criteria:
 *
 *   - forward-success: signed TunnelChannelEvent from runtime A's tunnel
 *     reaches runtime B's tunnel verbatim.
 *   - source-allowlist-reject: `sourceRuntimeId` mismatch → close A's
 *     tunnel + log, no message to B.
 *   - recipient-offline: `recipientRuntimeId` has no connected tunnel
 *     → drop + count + log, no message synthesized back to A.
 *   - recipient-same-as-source: A targets itself → message still
 *     arrives at A's own socket (no self-loop suppression; the
 *     runtime's outbound path should never target itself, but the
 *     hub must not silently drop a "self" envelope).
 *   - relay: signature + event body are forwarded byte-for-byte
 *     (hub does not re-encode).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";

import { createTestDb, resetTables } from "../fixtures/db.js";
import { createUser, createInstance } from "../fixtures/factories.js";
import {
  MockWebSocket,
  completeHandshake,
  makeRuntimeIdentity,
  seedRuntime,
} from "../fixtures/tunnel.js";

import configPlugin from "../../src/plugins/config.js";
import authPlugin from "../../src/plugins/auth.js";
import { setDb } from "../../src/db/index.js";
import { TunnelManager } from "../../src/services/tunnel-manager.js";
import { metrics, CounterName } from "../../src/services/metrics.js";

import type { TestDb } from "../fixtures/db.js";

// ---------------------------------------------------------------------------
// Test harness — mirrors `principal_forwarding.test.ts`'s shape, no HTTP
// routes (only the tunnel manager's in-memory state machine).
// ---------------------------------------------------------------------------

async function buildForwardingTestApp(testDb: TestDb) {
  const originalEnv = { ...process.env };
  process.env.DATABASE_URL = "postgres://localhost:5432/pekohub_test";
  process.env.S3_ENDPOINT = "http://localhost:9000";
  process.env.S3_ACCESS_KEY = "test";
  process.env.S3_SECRET_KEY = "test";
  process.env.S3_BUCKET = "test-bucket";
  process.env.MEILISEARCH_URL = "http://localhost:7700";
  process.env.MEILISEARCH_API_KEY = "test";
  process.env.JWT_SECRET = "test-secret-key-that-is-32-chars-long!!";
  process.env.NODE_ENV = "test";
  process.env.GC_ENABLED = "false";
  process.env.RATE_LIMIT_MAX = "1000";
  process.env.ALLOW_DEV_AUTH_BYPASS = "false";

  setDb(testDb.db);

  const app = Fastify({
    logger: false,
    bodyLimit: 100 * 1024 * 1024,
  });

  await app.register(configPlugin);
  await app.register(cors, { origin: true, credentials: true });
  await app.register(cookie);
  await app.register(authPlugin);

  const tunnelManager = new TunnelManager(app);
  app.decorate("tunnelManager", tunnelManager);

  app.setErrorHandler((error, _request, reply) => {
    reply.status(error.statusCode ?? 500).send({
      error: error.message,
    });
  });

  process.env = originalEnv;

  return { app, tunnelManager };
}

// Helper: wait for the manager's async dispatch to flush.
const flush = () => new Promise((r) => setTimeout(r, 30));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Cross-runtime channel event forwarding (peko-channel PR-C)", () => {
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

  it("forwards a signed TunnelChannelEvent from A to B verbatim", async () => {
    const { tunnelManager } = await buildForwardingTestApp(testDb);

    const ownerA = await createUser(testDb.client, { namespace: "alice" });
    const ownerB = await createUser(testDb.client, { namespace: "bob" });

    const idA = makeRuntimeIdentity();
    const idB = makeRuntimeIdentity();
    // Seed runtimes so the handshake completes (the hub-side
    // `isRuntimeAllowed` checks the `runtimes` table). We don't
    // create instances for channel events — channels have no
    // instance-level ACL on the hub (the hub is pure relay).
    await seedRuntime(testDb, idA.did, ownerA.id);
    await seedRuntime(testDb, idB.did, ownerB.id);

    const socketA = new MockWebSocket();
    const socketB = new MockWebSocket();
    tunnelManager.handleSocket(socketA.asWebSocket());
    tunnelManager.handleSocket(socketB.asWebSocket());

    await completeHandshake(socketA, idA.did, idA.privateKey);
    await completeHandshake(socketB, idB.did, idB.privateKey);

    expect(tunnelManager.isRuntimeConnected(idA.did)).toBe(true);
    expect(tunnelManager.isRuntimeConnected(idB.did)).toBe(true);

    // A emits a channel event targeted at B.
    const REQUEST_ID = "chan-evt-forward-1";
    const SIGNATURE = "base64url-channel-sig";
    socketA.triggerMessage({
      type: "tunnel_channel_event",
      requestId: REQUEST_ID,
      sourceRuntimeId: idA.did,
      recipientRuntimeId: idB.did,
      sourcePrincipalDid: "prin_alice",
      channelId: "chan_abcdefgh",
      event: {
        kind: "posted",
        channel: "chan_abcdefgh",
        author: "prin_alice",
        parent: null,
        text: "hello from A",
        at: "2026-08-06T12:00:00Z",
      },
      signature: SIGNATURE,
    });

    await flush();

    // B received the envelope verbatim — including `signature` and
    // `event` body. The hub does NOT re-encode.
    const receivedByB = socketB.sent.find(
      (m) => m.type === "tunnel_channel_event",
    );
    expect(receivedByB).toBeDefined();
    if (receivedByB?.type !== "tunnel_channel_event") throw new Error("unexpected");
    expect(receivedByB.requestId).toBe(REQUEST_ID);
    expect(receivedByB.sourceRuntimeId).toBe(idA.did);
    expect(receivedByB.recipientRuntimeId).toBe(idB.did);
    expect(receivedByB.sourcePrincipalDid).toBe("prin_alice");
    expect(receivedByB.channelId).toBe("chan_abcdefgh");
    expect(receivedByB.signature).toBe(SIGNATURE); // untouched
    expect(receivedByB.event.kind).toBe("posted");
    if (receivedByB.event.kind === "posted") {
      expect(receivedByB.event.text).toBe("hello from A");
      expect(receivedByB.event.author).toBe("prin_alice");
    }

    expect(metrics.snapshot()[CounterName.HubChannelEventForwarded]).toBe(1);
    expect(
      metrics.snapshot()[CounterName.HubChannelEventRecipientOffline],
    ).toBeUndefined();
    expect(
      metrics.snapshot()[CounterName.HubChannelEventRejectedSourceAllowlist],
    ).toBeUndefined();
  });

  it("closes the source tunnel when sourceRuntimeId doesn't match the authenticated runtime (impersonation)", async () => {
    const { tunnelManager } = await buildForwardingTestApp(testDb);

    const ownerA = await createUser(testDb.client, { namespace: "alice" });
    const ownerB = await createUser(testDb.client, { namespace: "bob" });

    const idA = makeRuntimeIdentity();
    const idB = makeRuntimeIdentity();
    await seedRuntime(testDb, idA.did, ownerA.id);
    await seedRuntime(testDb, idB.did, ownerB.id);

    const socketA = new MockWebSocket();
    const socketB = new MockWebSocket();
    tunnelManager.handleSocket(socketA.asWebSocket());
    tunnelManager.handleSocket(socketB.asWebSocket());
    await completeHandshake(socketA, idA.did, idA.privateKey);
    await completeHandshake(socketB, idB.did, idB.privateKey);

    // A claims to be sending on behalf of B's runtime DID.
    socketA.triggerMessage({
      type: "tunnel_channel_event",
      requestId: "chan-evt-impersonation",
      sourceRuntimeId: idB.did, // claim ≠ authed runtime
      recipientRuntimeId: idB.did,
      sourcePrincipalDid: "prin_alice",
      channelId: "chan_abcdefgh",
      event: {
        kind: "posted",
        channel: "chan_abcdefgh",
        author: "prin_alice",
        parent: null,
        text: "hi",
        at: "2026-08-06T12:00:00Z",
      },
      signature: "x",
    });

    await flush();

    // A's socket is closed.
    expect(socketA.closed).toBe(true);
    expect(socketA.closeCode).toBe(1000);
    expect(socketA.closeReason).toMatch(/source allowlist mismatch/);

    // B saw nothing.
    expect(
      socketB.sent.some((m) => m.type === "tunnel_channel_event"),
    ).toBe(false);

    // Counter incremented.
    expect(
      metrics.snapshot()[CounterName.HubChannelEventRejectedSourceAllowlist],
    ).toBe(1);
    expect(
      metrics.snapshot()[CounterName.HubChannelEventForwarded],
    ).toBeUndefined();
  });

  it("drops + counts when the recipient runtime has no connected tunnel", async () => {
    const { tunnelManager } = await buildForwardingTestApp(testDb);

    const ownerA = await createUser(testDb.client, { namespace: "alice" });
    const ownerB = await createUser(testDb.client, { namespace: "bob" });

    const idA = makeRuntimeIdentity();
    const idB = makeRuntimeIdentity();
    await seedRuntime(testDb, idA.did, ownerA.id);
    await seedRuntime(testDb, idB.did, ownerB.id);

    // Only A is connected; B has no socket at all.
    const socketA = new MockWebSocket();
    tunnelManager.handleSocket(socketA.asWebSocket());
    await completeHandshake(socketA, idA.did, idA.privateKey);

    socketA.triggerMessage({
      type: "tunnel_channel_event",
      requestId: "chan-evt-recipient-offline",
      sourceRuntimeId: idA.did,
      recipientRuntimeId: idB.did, // not connected
      sourcePrincipalDid: "prin_alice",
      channelId: "chan_abcdefgh",
      event: {
        kind: "posted",
        channel: "chan_abcdefgh",
        author: "prin_alice",
        parent: null,
        text: "anyone home?",
        at: "2026-08-06T12:00:00Z",
      },
      signature: "x",
    });

    await flush();

    // A gets no synthesized error (channel events have no response
    // channel); the envelope is silently dropped on the hub.
    expect(
      socketA.sent.some((m) => m.type === "tunnel_channel_event"),
    ).toBe(false);
    expect(
      metrics.snapshot()[CounterName.HubChannelEventRecipientOffline],
    ).toBe(1);
    expect(
      metrics.snapshot()[CounterName.HubChannelEventForwarded],
    ).toBeUndefined();
  });

  it("delivers a self-targeted event to the source runtime's own socket (no self-loop suppression)", async () => {
    // The runtime's outbound `fanout_event` should never target
    // itself (it iterates *remote* members). But if a runtime
    // somehow emits an event with recipient_runtime_id == its own
    // runtime_id, the hub must not silently drop it — that's a
    // runtime bug, not a hub bug. The envelope still lands on
    // A's own socket.
    const { tunnelManager } = await buildForwardingTestApp(testDb);

    const ownerA = await createUser(testDb.client, { namespace: "alice" });
    const idA = makeRuntimeIdentity();
    await seedRuntime(testDb, idA.did, ownerA.id);

    const socketA = new MockWebSocket();
    tunnelManager.handleSocket(socketA.asWebSocket());
    await completeHandshake(socketA, idA.did, idA.privateKey);

    socketA.triggerMessage({
      type: "tunnel_channel_event",
      requestId: "chan-evt-self",
      sourceRuntimeId: idA.did,
      recipientRuntimeId: idA.did, // self
      sourcePrincipalDid: "prin_alice",
      channelId: "chan_abcdefgh",
      event: {
        kind: "posted",
        channel: "chan_abcdefgh",
        author: "prin_alice",
        parent: null,
        text: "talking to myself",
        at: "2026-08-06T12:00:00Z",
      },
      signature: "x",
    });

    await flush();

    const receivedByA = socketA.sent.find(
      (m) => m.type === "tunnel_channel_event",
    );
    expect(receivedByA).toBeDefined();
    if (receivedByA?.type !== "tunnel_channel_event") throw new Error("unexpected");
    expect(receivedByA.requestId).toBe("chan-evt-self");

    expect(metrics.snapshot()[CounterName.HubChannelEventForwarded]).toBe(1);
  });

  it("forwards each event in a multi-event stream independently", async () => {
    // Verifies the dispatcher doesn't accidentally batch or
    // coalesce — each `tunnel_channel_event` is a separate
    // forward.
    const { tunnelManager } = await buildForwardingTestApp(testDb);

    const ownerA = await createUser(testDb.client, { namespace: "alice" });
    const ownerB = await createUser(testDb.client, { namespace: "bob" });

    const idA = makeRuntimeIdentity();
    const idB = makeRuntimeIdentity();
    await seedRuntime(testDb, idA.did, ownerA.id);
    await seedRuntime(testDb, idB.did, ownerB.id);

    const socketA = new MockWebSocket();
    const socketB = new MockWebSocket();
    tunnelManager.handleSocket(socketA.asWebSocket());
    tunnelManager.handleSocket(socketB.asWebSocket());
    await completeHandshake(socketA, idA.did, idA.privateKey);
    await completeHandshake(socketB, idB.did, idB.privateKey);

    for (let i = 0; i < 3; i++) {
      socketA.triggerMessage({
        type: "tunnel_channel_event",
        requestId: `chan-evt-multi-${i}`,
        sourceRuntimeId: idA.did,
        recipientRuntimeId: idB.did,
        sourcePrincipalDid: "prin_alice",
        channelId: "chan_abcdefgh",
        event: {
          kind: "posted",
          channel: "chan_abcdefgh",
          author: "prin_alice",
          parent: null,
          text: `message ${i}`,
          at: "2026-08-06T12:00:00Z",
        },
        signature: `sig-${i}`,
      });
    }

    await flush();

    const receivedByB = socketB.sent.filter(
      (m) => m.type === "tunnel_channel_event",
    );
    expect(receivedByB).toHaveLength(3);
    expect(
      metrics.snapshot()[CounterName.HubChannelEventForwarded],
    ).toBe(3);
  });
});
// ---------------------------------------------------------------------------
// The waiting runtime is woken when its recipient connects
// (`peer_runtime_online`). The Hub keeps who waits on whom, never the
// envelope: the sender's outbox resends it.
// ---------------------------------------------------------------------------

describe("Waking a runtime whose recipient comes online", () => {
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

  async function runtimes(count: number) {
    const { tunnelManager } = await buildForwardingTestApp(testDb);
    const owner = await createUser(testDb.client, { namespace: "alice" });
    const ids = [];
    for (let i = 0; i < count; i++) {
      const id = makeRuntimeIdentity();
      await seedRuntime(testDb, id.did, owner.id);
      ids.push(id);
    }
    return { tunnelManager, ids };
  }

  async function connect(
    tunnelManager: TunnelManager,
    id: { did: string; privateKey: Uint8Array },
  ) {
    const socket = new MockWebSocket();
    tunnelManager.handleSocket(socket.asWebSocket());
    await completeHandshake(socket, id.did, id.privateKey);
    return socket;
  }

  const post = (from: string, to: string, requestId: string) => ({
    type: "tunnel_channel_event" as const,
    requestId,
    sourceRuntimeId: from,
    recipientRuntimeId: to,
    sourcePrincipalDid: "prin_alice",
    channelId: "chan_abcdefgh",
    event: {
      kind: "posted" as const,
      channel: "chan_abcdefgh",
      author: "prin_alice",
      parent: null,
      text: "anyone home?",
      at: "2026-11-02T12:00:00Z",
    },
    signature: "x",
  });

  const invite = (from: string, to: string) => ({
    type: "tunnel_channel_invite" as const,
    requestId: "inv-1",
    sourceRuntimeId: from,
    recipientRuntimeId: to,
    sourcePrincipalDid: "prin_alice",
    channelId: "dm_abc",
    creator: "prin_alice",
    creatorDid: "prin_alice",
    name: "dm",
    kind: "dm",
    initialMembers: ["prin_alice", "prin_bob"],
    signature: "x",
  });

  const wakeups = (socket: MockWebSocket) =>
    socket.sent.filter((m) => m.type === "peer_runtime_online");

  it("tells the sender once its offline recipient connects, and only once", async () => {
    const { tunnelManager, ids } = await runtimes(2);
    const [a, b] = ids;
    const socketA = await connect(tunnelManager, a);

    socketA.triggerMessage(post(a.did, b.did, "evt-1"));
    socketA.triggerMessage(post(a.did, b.did, "evt-2"));
    await flush();
    expect(tunnelManager.waitingOn(a.did)).toEqual([b.did]);
    expect(wakeups(socketA)).toHaveLength(0);

    const socketB = await connect(tunnelManager, b);
    expect(wakeups(socketA)).toEqual([{ type: "peer_runtime_online", runtimeId: b.did }]);
    expect(wakeups(socketB)).toHaveLength(0);
    expect(tunnelManager.waitingOn(a.did)).toEqual([]);
    expect(metrics.snapshot()[CounterName.HubPeerRuntimeOnlineSent]).toBe(1);

    // B reconnecting later with nothing waiting wakes no one.
    socketB.close();
    await flush();
    await connect(tunnelManager, b);
    expect(wakeups(socketA)).toHaveLength(1);
  });

  it("remembers an invite to an offline runtime too", async () => {
    const { tunnelManager, ids } = await runtimes(2);
    const [a, b] = ids;
    const socketA = await connect(tunnelManager, a);
    socketA.triggerMessage(invite(a.did, b.did));
    await flush();
    await connect(tunnelManager, b);
    expect(wakeups(socketA)).toEqual([{ type: "peer_runtime_online", runtimeId: b.did }]);
  });

  it("wakes every connected waiter, skips one that went offline, and keeps no stale entry", async () => {
    const { tunnelManager, ids } = await runtimes(3);
    const [a, c, b] = ids;
    const socketA = await connect(tunnelManager, a);
    const socketC = await connect(tunnelManager, c);
    socketA.triggerMessage(post(a.did, b.did, "evt-a"));
    socketC.triggerMessage(post(c.did, b.did, "evt-c"));
    await flush();

    // C goes offline before B arrives; it resends on its own reconnect.
    socketC.close();
    await flush();
    await connect(tunnelManager, b);
    expect(wakeups(socketA)).toHaveLength(1);
    expect(wakeups(socketC)).toHaveLength(0);
    expect(tunnelManager.waitingOn(c.did)).toEqual([]);
  });

  it("never records a runtime waiting on itself, and a runtime can't send the wake-up", async () => {
    const { tunnelManager, ids } = await runtimes(2);
    const [a, b] = ids;
    const socketA = await connect(tunnelManager, a);
    socketA.triggerMessage(post(a.did, a.did, "evt-self"));
    socketA.triggerMessage({ type: "peer_runtime_online", runtimeId: b.did });
    await flush();
    expect(tunnelManager.waitingOn(a.did)).toEqual([]);
    expect(socketA.closed).toBe(false);
    const socketB = await connect(tunnelManager, b);
    expect(wakeups(socketB)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Runtime ADR-091: a person's history with a remote peko, asked of its host.
// The request comes only from the runtime registered to the person.
// ---------------------------------------------------------------------------

describe("Relaying a person's history requests", () => {
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

  async function setup() {
    const { tunnelManager } = await buildForwardingTestApp(testDb);
    const person = await createUser(testDb.client, { namespace: "alice" });
    const host = await createUser(testDb.client, { namespace: "bob" });
    const personRuntime = makeRuntimeIdentity();
    const hostRuntime = makeRuntimeIdentity();
    await seedRuntime(testDb, personRuntime.did, person.id);
    await seedRuntime(testDb, hostRuntime.did, host.id);
    const socketP = new MockWebSocket();
    tunnelManager.handleSocket(socketP.asWebSocket());
    await completeHandshake(socketP, personRuntime.did, personRuntime.privateKey);
    return { tunnelManager, person, host, personRuntime, hostRuntime, socketP };
  }

  async function connect(tunnelManager: TunnelManager, id: { did: string; privateKey: Uint8Array }) {
    const socket = new MockWebSocket();
    tunnelManager.handleSocket(socket.asWebSocket());
    await completeHandshake(socket, id.did, id.privateKey);
    return socket;
  }

  const request = (from: string, to: string, person: string, requestId = "hist-1") => ({
    type: "tunnel_channel_history_request" as const,
    requestId,
    sourceRuntimeId: from,
    recipientRuntimeId: to,
    sourcePrincipalDid: person,
    channelId: "dm_abc",
    limit: 100,
    signature: "x",
  });

  const histories = (socket: MockWebSocket, type: string) => socket.sent.filter((m) => m.type === type);

  it("forwards a person's request from their own runtime, and the page back", async () => {
    const { tunnelManager, person, personRuntime, hostRuntime, socketP } = await setup();
    const socketH = await connect(tunnelManager, hostRuntime);
    socketP.triggerMessage(request(personRuntime.did, hostRuntime.did, `user:hub:${person.id}`));
    await flush();
    expect(histories(socketH, "tunnel_channel_history_request")).toHaveLength(1);

    socketH.triggerMessage({
      type: "tunnel_channel_history",
      requestId: "hist-1",
      sourceRuntimeId: hostRuntime.did,
      recipientRuntimeId: personRuntime.did,
      channelId: "dm_abc",
      events: [],
      hasMore: false,
      signature: "y",
    });
    await flush();
    expect(histories(socketP, "tunnel_channel_history")).toHaveLength(1);
    expect(metrics.snapshot()[CounterName.HubHistoryForwarded]).toBe(2);
  });

  it("drops a request for someone else's account, or from no person at all", async () => {
    const { tunnelManager, host, personRuntime, hostRuntime, socketP } = await setup();
    const socketH = await connect(tunnelManager, hostRuntime);
    socketP.triggerMessage(request(personRuntime.did, hostRuntime.did, `user:hub:${host.id}`, "a"));
    socketP.triggerMessage(request(personRuntime.did, hostRuntime.did, "did:key:z6MkPrincipal", "b"));
    await flush();
    expect(histories(socketH, "tunnel_channel_history_request")).toHaveLength(0);
    expect(metrics.snapshot()[CounterName.HubHistoryRequestRejectedPerson]).toBe(2);
    expect(socketP.closed).toBe(false);
  });

  it("closes a runtime that claims another runtime's id", async () => {
    const { person, hostRuntime, socketP } = await setup();
    socketP.triggerMessage(request(hostRuntime.did, hostRuntime.did, `user:hub:${person.id}`));
    await flush();
    expect(socketP.closed).toBe(true);
  });

  it("rate-limits requests per runtime", async () => {
    const { tunnelManager, person, personRuntime, hostRuntime, socketP } = await setup();
    const socketH = await connect(tunnelManager, hostRuntime);
    for (let i = 0; i < 125; i++) {
      socketP.triggerMessage(request(personRuntime.did, hostRuntime.did, `user:hub:${person.id}`, `r${i}`));
    }
    await flush();
    await flush();
    expect(histories(socketH, "tunnel_channel_history_request")).toHaveLength(120);
    expect(metrics.snapshot()[CounterName.HubHistoryRequestRateLimited]).toBe(5);
  });

  it("wakes the person's runtime when an offline host comes back", async () => {
    const { tunnelManager, person, personRuntime, hostRuntime, socketP } = await setup();
    socketP.triggerMessage(request(personRuntime.did, hostRuntime.did, `user:hub:${person.id}`));
    await flush();
    expect(tunnelManager.waitingOn(personRuntime.did)).toEqual([hostRuntime.did]);
    await connect(tunnelManager, hostRuntime);
    expect(socketP.sent.filter((m) => m.type === "peer_runtime_online")).toHaveLength(1);
  });
});
