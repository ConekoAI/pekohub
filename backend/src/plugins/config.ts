import fp from 'fastify-plugin';
import { z } from 'zod';

const schema = z.object({
  PORT: z.string().default('3000'),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string(),
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: z.string(),
  S3_SECRET_KEY: z.string(),
  S3_BUCKET: z.string().default('pekohub-blobs'),
  S3_FORCE_PATH_STYLE: z.string().default('true'),
  MEILISEARCH_URL: z.string().url(),
  MEILISEARCH_API_KEY: z.string(),
  JWT_SECRET: z.string().min(32),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  REGISTRY_BASE_URL: z.string().url().default('http://localhost:3000'),
});

export type Config = z.infer<typeof schema>;

export default fp(async (fastify) => {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    fastify.log.error(parsed.error.format());
    throw new Error('Invalid configuration: ' + parsed.error.message);
  }
  fastify.decorate('config', parsed.data);
});
