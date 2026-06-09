/**
 * Test proxy for the database module.
 * This module is swapped in place of src/db/index.ts during tests
 * via Vitest's resolve.alias configuration.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../../src/db/schema.js";

// In tests, the pool is set via global before routes are imported
const pool = (globalThis as any).__TEST_DB_POOL__ as Pool | undefined;

if (!pool) {
  throw new Error(
    "Test database pool not set. " +
      "Make sure to set globalThis.__TEST_DB_POOL__ before importing routes.",
  );
}

export const db = drizzle(pool, { schema });
export type DB = typeof db;
