// server/src/pool.ts
import { Pool } from "pg";

/**
 * This Pool instance handles all PostgreSQL connections.
 * It automatically uses DATABASE_URL and standard PG* environment variables.
 *
 * Make sure to set DATABASE_URL in your .env, e.g.:
 * DATABASE_URL=postgresql://user:password@localhost:5432/yourdb
 */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Optional fine-tuning:
  // max: 10,                 // default pool size
  // idleTimeoutMillis: 30000 // how long a client can stay idle before being closed
});

export default pool;

/**
 * Helper for quick query() calls without manually connecting/releasing clients
 */
export async function query<T = any>(text: string, params?: any[]) {
  const res = await pool.query<T>(text, params);
  return res;
}
