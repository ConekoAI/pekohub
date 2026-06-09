import { describe, it, expect } from "vitest";
import {
  publicKeyFromDidKey,
  verifyDidKeySignature,
} from "../../src/services/tunnel-crypto.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";

const ED25519_PUB_MULTICODEC = new Uint8Array([0xed, 0x01]);

function makeDidKey(privateKeyHex?: string): {
  did: string;
  privateKey: Uint8Array;
} {
  const privateKey = privateKeyHex
    ? Uint8Array.from(Buffer.from(privateKeyHex, "hex"))
    : ed25519.keygen().secretKey;
  const publicKey = ed25519.getPublicKey(privateKey);
  const encoded = base58.encode(
    new Uint8Array([...ED25519_PUB_MULTICODEC, ...publicKey]),
  );
  return { did: `did:key:z${encoded}`, privateKey };
}

describe("tunnel-crypto", () => {
  describe("publicKeyFromDidKey", () => {
    it("extracts public key from a valid did:key", () => {
      const { did } = makeDidKey();
      const pubKey = publicKeyFromDidKey(did);
      expect(pubKey.length).toBe(32);
    });

    it("throws on invalid prefix", () => {
      expect(() => publicKeyFromDidKey("did:web:example")).toThrow(
        "Invalid did:key format",
      );
    });

    it("throws on missing z prefix", () => {
      expect(() => publicKeyFromDidKey("did:key:abc")).toThrow(
        "multibase base58btc prefix z missing",
      );
    });

    it("throws on wrong multicodec prefix", () => {
      const { secretKey } = ed25519.keygen();
      const publicKey = ed25519.getPublicKey(secretKey);
      const encoded = base58.encode(new Uint8Array([0xff, 0xff, ...publicKey]));
      expect(() => publicKeyFromDidKey(`did:key:z${encoded}`)).toThrow(
        "unsupported key type",
      );
    });
  });

  describe("verifyDidKeySignature", () => {
    it("verifies a valid signature", () => {
      const { did, privateKey } = makeDidKey();
      const message = "hello tunnel";
      const signature = ed25519.sign(
        new TextEncoder().encode(message),
        privateKey,
      );
      const valid = verifyDidKeySignature(
        did,
        message,
        Buffer.from(signature).toString("base64"),
      );
      expect(valid).toBe(true);
    });

    it("rejects an invalid signature", () => {
      const { did } = makeDidKey();
      const valid = verifyDidKeySignature(
        did,
        "hello tunnel",
        Buffer.from(new Uint8Array(64)).toString("base64"),
      );
      expect(valid).toBe(false);
    });

    it("rejects a mismatched message", () => {
      const { did, privateKey } = makeDidKey();
      const signature = ed25519.sign(
        new TextEncoder().encode("other message"),
        privateKey,
      );
      const valid = verifyDidKeySignature(
        did,
        "hello tunnel",
        Buffer.from(signature).toString("base64"),
      );
      expect(valid).toBe(false);
    });
  });
});
