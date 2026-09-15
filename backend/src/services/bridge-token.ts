/**
 * Bridge tokens — EdDSA JWTs the hub mints when proxying a chat to a
 * runtime (ADR-057).
 *
 * The signing key is a deterministic ed25519 keypair derived via
 * HKDF-SHA256 from `JWT_SECRET` (info string domain-separated below),
 * so no extra deployment secret is needed and the key survives
 * restarts. The matching public key is published at
 * `/v1/jwks.json`; runtimes build a `JwtValidator` against the hub
 * origin they already hold in their pekohub credential and reject
 * every bridge request that does not carry a token this service
 * signed.
 *
 * Token shape:
 *   header  { alg: "EdDSA", typ: "JWT", kid }
 *   claims  { iss: PUBLIC_ORIGIN, sub, aud: runtimeDID, iat, exp, jti }
 *
 * `sub` values:
 *   - user-kind caller     → the pekohub user id (JWT sub / API-key owner)
 *   - principal-kind caller→ `principal:<did>` (the runtime attributes
 *                            it as `Subject::Principal`)
 *   - anonymous visitor    → the visitor id (runtime maps to a
 *                            user-identity shard; exposure ACL still
 *                            gates what a visitor may touch)
 */

import { createHash, hkdfSync, randomUUID } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";

const BRIDGE_TOKEN_TTL_SECS = 60;
const HKDF_INFO = "pekohub-bridge-ed25519-v1";

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** Deterministic 32-byte ed25519 seed derived from the JWT secret. */
export function bridgeSigningSeed(jwtSecret: string): Uint8Array {
  const derived = hkdfSync(
    "sha256",
    Buffer.from(jwtSecret, "utf8"),
    Buffer.alloc(0),
    HKDF_INFO,
    32,
  );
  return new Uint8Array(derived);
}

/** Raw 32-byte ed25519 public key matching the bridge signing key. */
export function bridgePublicKey(jwtSecret: string): Uint8Array {
  return ed25519.getPublicKey(bridgeSigningSeed(jwtSecret));
}

/** Stable key id — derived from the public key so a secret rotation
 *  (and thus a key rotation) produces a new `kid`. */
export function bridgeKeyId(jwtSecret: string): string {
  const hash = createHash("sha256")
    .update(bridgePublicKey(jwtSecret))
    .digest("hex");
  return `pekohub-bridge-${hash.slice(0, 16)}`;
}

export interface BridgeTokenInput {
  /** Caller identity: pekohub user id, `principal:<did>`, or a
   *  visitor id. Becomes the JWT `sub` claim. */
  sub: string;
  /** Target runtime DID (the only audience that may accept it). */
  aud: string;
  /** Hub public origin — must match the runtime's trusted issuer. */
  iss: string;
}

/** Mint a short-lived EdDSA bridge token. */
export function mintBridgeToken(jwtSecret: string, input: BridgeTokenInput): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "EdDSA", typ: "JWT", kid: bridgeKeyId(jwtSecret) };
  const claims = {
    iss: input.iss,
    sub: input.sub,
    aud: input.aud,
    iat: now,
    exp: now + BRIDGE_TOKEN_TTL_SECS,
    jti: randomUUID(),
  };
  const encoder = new TextEncoder();
  const signingInput = `${b64url(encoder.encode(JSON.stringify(header)))}.${b64url(
    encoder.encode(JSON.stringify(claims)),
  )}`;
  const signature = ed25519.sign(
    encoder.encode(signingInput),
    bridgeSigningSeed(jwtSecret),
  );
  return `${signingInput}.${b64url(signature)}`;
}

/** The JWKS document runtimes fetch from `/v1/jwks.json`. */
export function bridgeJwks(jwtSecret: string): {
  keys: Array<Record<string, string>>;
} {
  return {
    keys: [
      {
        kty: "OKP",
        crv: "Ed25519",
        x: b64url(bridgePublicKey(jwtSecret)),
        kid: bridgeKeyId(jwtSecret),
        alg: "EdDSA",
        use: "sig",
      },
    ],
  };
}
