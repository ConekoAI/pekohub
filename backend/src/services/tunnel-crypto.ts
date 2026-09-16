/**
 * did:key Ed25519 utilities for tunnel authentication.
 *
 * The runtime uses did:key identifiers where the method-specific identifier
 * is a base58btc-encoded multicodec-prefixed Ed25519 public key:
 *
 *   did:key:z6Mk<public-key-bytes>
 *
 * The multicodec prefix for Ed25519 pub is 0xed01 (varint: 0xed 0x01).
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { compactVerify, importJWK } from "jose";

const ED25519_PUB_MULTICODEC = new Uint8Array([0xed, 0x01]);

export class TunnelAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TunnelAuthError";
  }
}

/**
 * Extract the raw 32-byte Ed25519 public key from a did:key string.
 */
export function publicKeyFromDidKey(did: string): Uint8Array {
  if (!did.startsWith("did:key:")) {
    throw new TunnelAuthError("Invalid did:key format: missing did:key prefix");
  }

  const methodSpecificId = did.slice("did:key:".length);
  if (!methodSpecificId.startsWith("z")) {
    throw new TunnelAuthError(
      "Invalid did:key format: multibase base58btc prefix z missing",
    );
  }

  const decoded = base58.decode(methodSpecificId.slice(1));
  if (decoded.length < ED25519_PUB_MULTICODEC.length + 32) {
    throw new TunnelAuthError("Invalid did:key format: decoded key too short");
  }

  // Verify multicodec prefix
  for (let i = 0; i < ED25519_PUB_MULTICODEC.length; i++) {
    if (decoded[i] !== ED25519_PUB_MULTICODEC[i]) {
      throw new TunnelAuthError("Invalid did:key format: unsupported key type");
    }
  }

  const pubKey = decoded.slice(ED25519_PUB_MULTICODEC.length);
  if (pubKey.length !== 32) {
    throw new TunnelAuthError(
      `Invalid Ed25519 public key length: ${pubKey.length}`,
    );
  }

  return pubKey;
}

/**
 * Verify that `signatureBase64` is a valid Ed25519 signature of `message`
 * by the public key embedded in `didKey`.
 */
export function verifyDidKeySignature(
  didKey: string,
  message: string | Uint8Array,
  signatureBase64: string,
): boolean {
  try {
    const pubKey = publicKeyFromDidKey(didKey);
    const messageBytes =
      typeof message === "string" ? new TextEncoder().encode(message) : message;
    const signature = Buffer.from(signatureBase64, "base64");
    if (signature.length !== 64) {
      return false;
    }
    return ed25519.verify(signature, messageBytes, pubKey);
  } catch {
    return false;
  }
}

/**
 * ADR-058 D4: verify a compact JWS (EdDSA, embedded JSON payload)
 * against the Ed25519 key embedded in `didKey`. Returns the parsed
 * payload on success, `null` on any failure (bad DID, bad signature,
 * non-JSON payload). Callers MUST then check the payload's claims
 * (nonce/ids/iat/exp) against the request they gate — this helper
 * only establishes "the DID's key signed these bytes".
 *
 * The raw 32-byte key is imported as a JWK
 * `{ kty: "OKP", crv: "Ed25519", x: base64url(pubkey) }` per the
 * ADR-058 contract so the runtime side can mirror the verification
 * with any JWS library.
 */
export async function verifyDidKeyJws(
  didKey: string,
  jws: string,
): Promise<Record<string, unknown> | null> {
  try {
    const pubKey = publicKeyFromDidKey(didKey);
    const key = await importJWK(
      {
        kty: "OKP",
        crv: "Ed25519",
        x: Buffer.from(pubKey).toString("base64url"),
      },
      "EdDSA",
    );
    const { payload } = await compactVerify(jws, key);
    const parsed: unknown = JSON.parse(new TextDecoder().decode(payload));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
