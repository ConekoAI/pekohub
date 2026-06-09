import type { PGlite } from "@electric-sql/pglite";
import type { TestUser } from "./factories.js";

const DEFAULT_JWT_SECRET = "test-secret-key-that-is-32-chars-long!!";

/**
 * Generate a JWT token for a test user using fast-jwt (same as @fastify/jwt).
 */
export async function generateTestToken(
  user: TestUser,
  secret: string = DEFAULT_JWT_SECRET,
): Promise<string> {
  const { createSigner } = await import("fast-jwt");
  const signer = createSigner({ key: secret, algorithm: "HS256" });
  return signer({ sub: String(user.id), namespace: user.namespace });
}

/**
 * Create an authenticated request headers object with Bearer token.
 */
export async function authHeaders(
  user: TestUser,
  secret?: string,
): Promise<{ Authorization: string }> {
  const token = await generateTestToken(user, secret);
  return { Authorization: `Bearer ${token}` };
}

/**
 * Create a test user and return both the user and auth headers.
 */
export async function createAuthenticatedUser(
  client: PGlite,
  overrides: Partial<TestUser> = {},
  secret?: string,
): Promise<{ user: TestUser; headers: { Authorization: string } }> {
  const { createUser } = await import("./factories.js");
  const user = await createUser(client, overrides);
  const headers = await authHeaders(user, secret);
  return { user, headers };
}
