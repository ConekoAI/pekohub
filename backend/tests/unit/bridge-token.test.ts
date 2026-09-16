import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  mintBridgeToken,
  bridgePublicKey,
} from "../../src/services/bridge-token.js";
import { TunnelRouter } from "../../src/services/tunnel-router.js";
import type { HttpProxiedRequest } from "../../src/services/tunnel-protocol.js";

const SECRET = "test-secret-key-that-is-32-chars-long!!";
const ISSUER = "https://hub.example.com";
const RUNTIME_DID = "did:key:z6MkrJVnaZkeF8QyTZuNb6vQvVhGHCbUvJqeEv7m1Fje5xJi";

function decodeClaims(token: string): Record<string, unknown> {
  const parts = token.split(".");
  expect(parts.length).toBe(3);
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
}

describe("mintBridgeToken (ADR-058 D5)", () => {
  it("embeds the typed kind claim and verifies against the JWKS key", () => {
    const token = mintBridgeToken(SECRET, {
      sub: "user-123",
      kind: "user",
      aud: RUNTIME_DID,
      iss: ISSUER,
    });
    const claims = decodeClaims(token);
    expect(claims).toMatchObject({
      iss: ISSUER,
      sub: "user-123",
      kind: "user",
      aud: RUNTIME_DID,
    });
    expect(typeof claims.jti).toBe("string");

    // Signature verifies against the published public key.
    const [h, p, s] = token.split(".");
    const ok = ed25519.verify(
      Buffer.from(s, "base64url"),
      new TextEncoder().encode(`${h}.${p}`),
      bridgePublicKey(SECRET),
    );
    expect(ok).toBe(true);
  });

  it("mints visitor-kind tokens", () => {
    const token = mintBridgeToken(SECRET, {
      sub: "visitor-abc",
      kind: "visitor",
      aud: RUNTIME_DID,
      iss: ISSUER,
    });
    expect(decodeClaims(token)).toMatchObject({
      sub: "visitor-abc",
      kind: "visitor",
    });
  });
});

/** Capture the proxied request a TunnelRouter builds, without a real
 *  WebSocket tunnel. */
class StubTunnelManager {
  lastRequest: HttpProxiedRequest | null = null;
  isRuntimeConnected() {
    return true;
  }
  async startStream(
    _runtimeId: string,
    request: HttpProxiedRequest,
    sink: { onEnd: () => void },
  ) {
    this.lastRequest = request;
    sink.onEnd();
  }
  async broadcastControl() {}
}

function fakeReply() {
  return {
    status() {
      return { send() {} };
    },
    raw: {
      getHeader() {
        return undefined;
      },
      writeHead() {},
      write() {},
      end() {},
    },
  };
}

describe("TunnelRouter bridge headers (ADR-058 D5)", () => {
  function build() {
    const app = Fastify({ logger: false });
    const manager = new StubTunnelManager();
    const quotaStore = { consume: async () => ({ allowed: true }) };
    const router = new TunnelRouter(manager as any, quotaStore as any, {
      issuer: ISSUER,
      jwtSecret: SECRET,
    });
    return { manager, router };
  }

  it("mints kind=user with the hub user id for authenticated callers", async () => {
    const { manager, router } = build();
    await router.proxyChat(
      RUNTIME_DID,
      "inst-1",
      "principal",
      {},
      {},
      fakeReply() as any,
      { kind: "user", id: "user-uuid-1" },
    );
    const auth = manager.lastRequest!.headers.authorization;
    const claims = decodeClaims(auth.replace(/^Bearer /, ""));
    expect(claims).toMatchObject({ sub: "user-uuid-1", kind: "user", aud: RUNTIME_DID });
  });

  it("mints kind=visitor with the visitor id for anonymous callers", async () => {
    const { manager, router } = build();
    await router.proxyChat(
      RUNTIME_DID,
      "inst-1",
      "principal",
      {},
      {},
      fakeReply() as any,
      null,
      "visitor-id-9",
    );
    const auth = manager.lastRequest!.headers.authorization;
    const claims = decodeClaims(auth.replace(/^Bearer /, ""));
    expect(claims).toMatchObject({ sub: "visitor-id-9", kind: "visitor" });
  });

  it("refuses to mint a token for a principal-kind caller (fail closed)", async () => {
    const { router } = build();
    await expect(
      router.proxyChat(
        RUNTIME_DID,
        "inst-1",
        "principal",
        {},
        {},
        fakeReply() as any,
        { kind: "principal", id: "did:key:z6Mk..." } as any,
      ),
    ).rejects.toThrow(/caller kind/);
  });
});
