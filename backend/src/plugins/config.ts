import fp from "fastify-plugin";
import { z } from "zod";

const schema = z.object({
  PORT: z.string().default("3000"),
  HOST: z.string().default("0.0.0.0"),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  DATABASE_URL: z.string(),
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default("us-east-1"),
  S3_ACCESS_KEY: z.string(),
  S3_SECRET_KEY: z.string(),
  S3_BUCKET: z.string().default("pekohub-blobs"),
  S3_FORCE_PATH_STYLE: z.string().default("true"),
  MEILISEARCH_URL: z.string().url(),
  MEILISEARCH_API_KEY: z.string(),
  JWT_SECRET: z.string().min(32),
  // The Hub's API origin. Must match the origin runtimes derive from
  // their pekohub credential (tunnel URL scheme swapped to https) — it
  // is the bridge token's `iss` and the JWKS host.
  PUBLIC_ORIGIN: z.string().url().default("https://api.pekohub.ai"),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  REGISTRY_BASE_URL: z.string().url().default("http://localhost:3000"),
  // The website's origin (share links, seed pages, sign-in consent).
  FRONTEND_URL: z.string().url().optional(),
  ALLOW_DEV_AUTH_BYPASS: z.enum(["true", "false"]).default("false"),
  // Anonymous visitor chat through the public chat proxy. Off: the
  // website offers no chat, and the proxy serves signed-in clients that
  // have no runtime of their own (a future mobile app). On: callers
  // without an account chat under a signed visitor cookie.
  ALLOW_VISITOR_CHAT: z.enum(["true", "false"]).default("false"),
  RATE_LIMIT_MAX: z.coerce.number().default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60_000),
});

export type Config = z.infer<typeof schema>;

export default fp(async (fastify) => {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    fastify.log.error(parsed.error.format());
    throw new Error("Invalid configuration: " + parsed.error.message);
  }
  fastify.decorate("config", parsed.data);
});
