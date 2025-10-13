// server/src/db.ts
import "dotenv/config";
import { Pool, PoolClient, QueryResult } from "pg";

const isProd = process.env.NODE_ENV === "production";

// Require DATABASE_URL in production (never hard-code secrets in code)
const connectionString = process.env.DATABASE_URL || (isProd ? "" : undefined);
if (isProd && !connectionString) {
  // Fail fast if missing in prod
  throw new Error("DATABASE_URL is required in production");
}

// SSL on Render/Postgres; disabled locally
const ssl =
  connectionString && !/localhost|127\.0\.0\.1/i.test(connectionString)
    ? { rejectUnauthorized: false }
    : undefined;

export const pool = new Pool({
  connectionString,
  ssl,
  // Sensible defaults for Render
  max: Number(process.env.PG_POOL_MAX || 20),
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT || 30_000),
  connectionTimeoutMillis: Number(process.env.PG_CONN_TIMEOUT || 10_000),
  keepAlive: true,
});

// Optional: log once to confirm connectivity (no secrets)
pool
  .connect()
  .then((client) => client.query("SELECT 1").finally(() => client.release()))
  .then(() => {
    console.log(
      `[db] connected (ssl=${!!ssl}) env=${process.env.NODE_ENV} poolMax=${process.env.PG_POOL_MAX || 20}`
    );
  })
  .catch((err) => {
    console.error("[db] initial connection failed:", {
      message: err?.message,
      code: err?.code,
      detail: err?.detail,
      hint: err?.hint,
    });
  });

export async function query<T = any>(text: string, params?: any[]): Promise<QueryResult<T>> {
  return pool.query<T>(text, params);
}
export async function q(sql: string, params: any[] = []) {
  return query(sql, params);
}

export type { PoolClient, QueryResult };
export default { query, q, pool };
