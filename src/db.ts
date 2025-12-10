// server/src/db.ts
import { Pool, PoolClient, QueryResult } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // you can add ssl or other pool options here if required
  // ssl: { rejectUnauthorized: false },
});

// Basic typed query wrapper
async function query<T = any>(text: string, params?: any[]): Promise<QueryResult<T>> {
  return pool.query<T>(text, params);
}

// alias for some code that expects db.q(...)
const q = query;

// pg-promise-like helpers

/**
 * any(sql, params) -> returns rows[]
 */
async function any<T = any>(text: string, params?: any[]): Promise<T[]> {
  const res = await query<T>(text, params);
  return res.rows;
}

/**
 * one(sql, params) -> returns single row or throws if none
 */
async function one<T = any>(text: string, params?: any[]): Promise<T> {
  const res = await query<T>(text, params);
  if (!res.rows || res.rows.length === 0) {
    throw new Error("No data returned (one) for query: " + text);
  }
  return res.rows[0];
}

/**
 * oneOrNone(sql, params) -> returns single row or null
 */
async function oneOrNone<T = any>(text: string, params?: any[]): Promise<T | null> {
  const res = await query<T>(text, params);
  if (!res.rows || res.rows.length === 0) return null;
  return res.rows[0];
}

/**
 * none(sql, params) -> execute and return void
 */
async function none(text: string, params?: any[]): Promise<void> {
  await query(text, params);
  return;
}

/**
 * Transaction helper: tx(async (t) => { await t.none(...); const r = await t.one(...); })
 *
 * The callback receives a lightweight client object with the same helper methods:
 * { query, any, one, oneOrNone, none, rawClient }
 */
async function tx<T = any>(fn: (t: {
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
    // create wrapper bound to this client
    const boundQuery = async <R = any>(text: string, params?: any[]) => client.query<R>(text, params);

    const txHelpers = {
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

    const result = await fn(txHelpers);
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

// Export types for other modules that expect PoolClient
export { pool, PoolClient };

// Default export — object with helpers (many files import default)
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
