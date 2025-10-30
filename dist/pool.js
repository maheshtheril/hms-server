"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.query = query;
// server/src/pool.ts
const pg_1 = require("pg");
/**
 * This Pool instance handles all PostgreSQL connections.
 * It automatically uses DATABASE_URL and standard PG* environment variables.
 *
 * Make sure to set DATABASE_URL in your .env, e.g.:
 * DATABASE_URL=postgresql://user:password@localhost:5432/yourdb
 */
const pool = new pg_1.Pool({
    connectionString: process.env.DATABASE_URL,
    // Optional fine-tuning:
    // max: 10,                 // default pool size
    // idleTimeoutMillis: 30000 // how long a client can stay idle before being closed
});
exports.default = pool;
/**
 * Helper for quick query() calls without manually connecting/releasing clients
 */
async function query(text, params) {
    const res = await pool.query(text, params);
    return res;
}
