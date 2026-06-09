/**
 * Test-specific database module.
 * This is a drop-in replacement for src/db/index.ts in tests.
 * The actual pool is set at runtime by buildTestApp.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../../src/db/schema.js";

let _pool: Pool | null = null;

export function setTestPool(pool: Pool) {
  _pool = pool;
}

export function getTestPool(): Pool {
  if (!_pool) {
    throw new Error(
      "Test pool not set. Call setTestPool() before using the test DB.",
    );
  }
  return _pool;
}

export const testDb = drizzle(() => getTestPool(), { schema });
