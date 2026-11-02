import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    // Migrations need a direct (unpooled) connection where the app uses a
    // pooler, as on Neon; MIGRATION_DATABASE_URL names it.
    url:
      process.env.MIGRATION_DATABASE_URL ??
      process.env.DATABASE_URL ??
      'postgres://pekohub:pekohub@localhost:5432/pekohub',
  },
});
