import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export const db = drizzle(pool, { schema });
export type DB = typeof db;

/**
 * Replace the database instance (used in tests).
 * This allows tests to inject an in-memory or test-specific database.
 */
export function setDb(newDb: typeof db) {
  Object.assign(db, newDb);
}
