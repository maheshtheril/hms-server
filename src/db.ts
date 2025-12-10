// server/src/db.ts
import { Pool, PoolClient, QueryResult } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // add ssl or other pool options if needed
});

// Basic typed query wrapper (pg style)
export async function query<T = any>(text: string, params?: any[]): Promise<QueryResult<T>> {
  return pool.query<T>(text, params);
}

// alias used in some files
export const q = query;

// pg-promise-like helpers as named exports

export async function any<T = any>(text: string, params?: any[]): Promise<T[]> {
  const res = await query<T>(text, params);
  return res.rows;
}

export async function one<T = any>(text: string, params?: any[]): Promise<T> {
  const res = await query<T>(text, params);
  if (!res.rows || res.rows.length === 0) {
    throw new Error("No data returned (one) for query: " + text);
  }
  return res.rows[0] as T;
}

export async function oneOrNone<T = any>(text: string, params?: any[]): Promise<T | null> {
  const res = await query<T>(text, params);
  if (!res.rows || res.rows.length === 0) return null;
  return res.rows[0] as T;
}

export async function none(text: string, params?: any[]): Promise<void> {
  await query(text, params);
  return;
}

/**
 * tx(fn) -> run a transaction and provide a client-bound helper object
 * Usage:
 *   await tx(async (t) => { const row = await t.one(...); await t.none(...); });
 */
export async function tx<T = any>(fn: (t: {
  query: typeof query;
  q: typeof q;
  any: typeof any;
  one: typeof one;
  oneOrNone: typeof oneOrNone;
  none: typeof none;
  rawClient: PoolClient;
}) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const boundQuery = async <R = any>(text: string, params?: any[]) => client.query<R>(text, params);

    const helpers = {
      query: boundQuery,
      q: boundQuery,
      any: async <R = any>(text: string, params?: any[]) => {
        const r = await boundQuery<R>(text, params);
        return r.rows;
      },
      one: async <R = any>(text: string, params?: any[]) => {
        const r = await boundQuery<R>(text, params);
        if (!r.rows || r.rows.length === 0) {
          throw new Error("No data returned (one) for query: " + text);
        }
        return r.rows[0] as R;
      },
      oneOrNone: async <R = any>(text: string, params?: any[]) => {
        const r = await boundQuery<R>(text, params);
        if (!r.rows || r.rows.length === 0) return null;
        return r.rows[0] as R;
      },
      none: async (text: string, params?: any[]) => {
        await boundQuery(text, params);
      },
      rawClient: client,
    };

    const result = await fn(helpers);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rbErr) {
      console.error("Rollback error", rbErr);
    }
    throw err;
  } finally {
    client.release();
  }
}

// export PoolClient type and pool instance
export { pool, PoolClient };

// default export for modules doing `import db from "../db"`
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
