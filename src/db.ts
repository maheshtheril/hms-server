// server/src/db.ts
import "dotenv/config";
import { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

const isProd = process.env.NODE_ENV === "production";

// Require DATABASE_URL in production (never hard-code secrets in code)
const connectionString = process.env.DATABASE_URL || (isProd ? "" : undefined);
if (isProd && !connectionString) {
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

// ✅ Constrain T to QueryResultRow so pg typings are satisfied
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: any[]
): Promise<QueryResult<T>> {
  return pool.query<T>(text, params);
}

export async function q<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: any[] = []
) {
  return query<T>(sql, params);
}

export type { PoolClient, QueryResult, QueryResultRow };
export default { query, q, pool };
