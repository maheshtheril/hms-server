// server/src/dbCompat.ts
// Thin compatibility wrapper so existing code that expects `getClient()` can keep using it
// without changing the original server/src/db.ts file.

import dbDefault, * as dbNamed from "./db";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";

// dbDefault is likely the default export (object) or maybe a function — handle both.

// helper: if dbDefault is an object with pool, use pool.connect()
// if dbDefault is a function, call it (backwards-compatible)
async function obtainClient(): Promise<PoolClient> {
  // @ts-ignore
  if (typeof dbDefault === "function") {
    // original db exported a function (already callable)
    // @ts-ignore
    return dbDefault();
  }
  // otherwise expect an exported pool: dbDefault.pool or dbNamed.pool
  const maybePool = (dbDefault && (dbDefault.pool)) || (dbNamed && (dbNamed as any).pool);
  if (!maybePool || typeof maybePool.connect !== "function") {
    throw new Error("dbCompat: unable to find pool.connect on ./db — inspect server/src/db.ts");
  }
  return maybePool.connect();
}

// Named export q: reuse existing q if present, otherwise re-export query wrapper
export const q = (dbNamed && (dbNamed as any).q) || (async function<T extends QueryResultRow = any>(text: string, params?: any[]) {
  // @ts-ignore
  if (dbDefault && typeof dbDefault.query === "function") return dbDefault.query(text, params);
  throw new Error("dbCompat: no query function available on ./db");
});

// named export getClient
export async function getClient(): Promise<PoolClient> {
  return obtainClient();
}

// default export getClient — so `import getClient from "./dbCompat"` works
export default getClient;

// also expose pool if available
export const pool = (dbDefault && (dbDefault.pool)) || ((dbNamed as any).pool) || null;
