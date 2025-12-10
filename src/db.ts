// server/src/db.ts
import { Pool, PoolClient, QueryResult } from "pg";

// -------------------------------
// 1) SSL AUTO-DETECT LOGIC
// -------------------------------
const connectionString = process.env.DATABASE_URL || "";

const needsSSL =
  connectionString.includes("sslmode=require") ||
  process.env.PGSSLMODE === "require" ||
  process.env.NODE_ENV === "production";

// -------------------------------
// 2) CREATE POOL FIRST (IMPORTANT)
// -------------------------------
export const pool = new Pool({
  connectionString,
  ...(needsSSL
    ? {
        ssl: {
          rejectUnauthorized: false,
        },
      }
    : {}),
});

// -------------------------------
// 3) BASE QUERY HELPERS
// -------------------------------
export async function query<T = any>(
  text: string,
  params?: any[]
): Promise<QueryResult<T>> {
  return pool.query<T>(text, params);
}

// alias for older code
export const q = query;

// -------------------------------
// 4) PG-PROMISE-STYLE HELPERS
// -------------------------------
export async function any<T = any>(sql: string, params?: any[]): Promise<T[]> {
  const res = await query<T>(sql, params);
  return res.rows;
}

export async function one<T = any>(sql: string, params?: any[]): Promise<T> {
  const res = await query<T>(sql, params);
  if (!res.rows.length) throw new Error("one(): no rows returned");
  return res.rows[0];
}

export async function oneOrNone<T = any>(
  sql: string,
  params?: any[]
): Promise<T | null> {
  const res = await query<T>(sql, params);
  return res.rows.length ? res.rows[0] : null;
}

export async function none(sql: string, params?: any[]): Promise<void> {
  await query(sql, params);
}

// -------------------------------
// 5) TRANSACTION WRAPPER (tx)
// -------------------------------
export async function tx<T = any>(
  fn: (t: {
    query: typeof query;
    q: typeof q;
    any: typeof any;
    one: typeof one;
    oneOrNone: typeof oneOrNone;
    none: typeof none;
    rawClient: PoolClient;
  }) => Promise<T>
): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const boundQuery = async <R = any>(sql: string, params?: any[]) =>
      client.query<R>(sql, params);

    const helpers = {
      query: boundQuery,
      q: boundQuery,
      any: async <R = any>(sql: string, params?: any[]) => {
        const res = await boundQuery<R>(sql, params);
        return res.rows;
      },
      one: async <R = any>(sql: string, params?: any[]) => {
        const res = await boundQuery<R>(sql, params);
        if (!res.rows.length) throw new Error("tx.one(): no rows returned");
        return res.rows[0];
      },
      oneOrNone: async <R = any>(sql: string, params?: any[]) => {
        const res = await boundQuery<R>(sql, params);
        return res.rows.length ? res.rows[0] : null;
      },
      none: async (sql: string, params?: any[]) => {
        await boundQuery(sql, params);
      },
      rawClient: client,
    };

    const result = await fn(helpers);

    await client.query("COMMIT");

    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// -------------------------------
// 6) DEFAULT EXPORT (for old code)
// -------------------------------
const db = {
  pool,
  query,
  q,
  any,
  one,
  oneOrNone,
  none,
  tx,
};

export default db;

// Export PoolClient type
export { PoolClient };
