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
 *   claims  { iss: PUBLIC_ORIGIN, sub, kind, aud: runtimeDID, iat, exp, jti }
 *
 * ADR-058 D5 — typed caller claims. `kind` is REQUIRED and tells the
 * runtime how to interpret `sub`:
 *   - "user"    → `sub` is the pekohub user id (JWT sub / API-key
 *                 owner) of an authenticated hub caller.
 *   - "visitor" → `sub` is a hub-minted anonymous visitor id (see
 *                 `visitor-cookie.ts`; HMAC-signed, never
 *                 client-supplied). The runtime maps it to a
 *                 user-identity shard; exposure ACL still gates what
 *                 a visitor may touch.
 *
 * There is deliberately NO `principal:`-prefixed `sub` path: the hub
 * never signs a caller-supplied identifier into a bridge token.
 */

import { createHash, hkdfSync, randomUUID } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";

const BRIDGE_TOKEN_TTL_SECS = 60;
const HKDF_INFO = "pekohub-bridge-ed25519-v1";

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/**
 * Shared HKDF-SHA256 derivation from the JWT secret. Domain-separate
 * every consumer with its own `info` string (bridge signing key,
 * visitor-cookie HMAC key, ...) so a single deployment secret yields
 * independent keys. Same primitive as `bridgeSigningSeed` — extracted
 * so sibling services don't re-implement the hkdfSync call.
 */
export function hkdfFromJwtSecret(
  jwtSecret: string,
  info: string,
  length: number,
): Uint8Array {
  const derived = hkdfSync(
    "sha256",
    Buffer.from(jwtSecret, "utf8"),
    Buffer.alloc(0),
    info,
    length,
  );
  return new Uint8Array(derived);
}

/** Deterministic 32-byte ed25519 seed derived from the JWT secret. */
export function bridgeSigningSeed(jwtSecret: string): Uint8Array {
  return hkdfFromJwtSecret(jwtSecret, HKDF_INFO, 32);
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

/** ADR-058 D5: how the runtime must interpret the bridge token's
 *  `sub` claim. */
export type BridgeCallerKind = "user" | "visitor";

export interface BridgeTokenInput {
  /** Caller identity. For `kind: "user"` the pekohub user id; for
   *  `kind: "visitor"` a hub-minted (HMAC-verified) visitor id.
   *  Becomes the JWT `sub` claim. MUST NOT be a client-supplied
   *  string — see ADR-058 D5. */
  sub: string;
  /** Typed claim paired with `sub`. */
  kind: BridgeCallerKind;
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
    kind: input.kind,
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
