"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pool = void 0;
exports.query = query;
exports.q = q;
// server/src/db.ts
require("dotenv/config");
const pg_1 = require("pg");
const isProd = process.env.NODE_ENV === "production";
// Require DATABASE_URL in production (never hard-code secrets in code)
const connectionString = process.env.DATABASE_URL || (isProd ? "" : undefined);
if (isProd && !connectionString) {
    throw new Error("DATABASE_URL is required in production");
}
// SSL on Render/Postgres; disabled locally
const ssl = connectionString && !/localhost|127\.0\.0\.1/i.test(connectionString)
    ? { rejectUnauthorized: false }
    : undefined;
exports.pool = new pg_1.Pool({
    connectionString,
    ssl,
    max: Number(process.env.PG_POOL_MAX || 20),
    idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT || 30_000),
    connectionTimeoutMillis: Number(process.env.PG_CONN_TIMEOUT || 10_000),
    keepAlive: true,
});
// Optional: log once to confirm connectivity (no secrets)
exports.pool
    .connect()
    .then((client) => client.query("SELECT 1").finally(() => client.release()))
    .then(() => {
    console.log(`[db] connected (ssl=${!!ssl}) env=${process.env.NODE_ENV} poolMax=${process.env.PG_POOL_MAX || 20}`);
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
async function query(text, params) {
    return exports.pool.query(text, params);
}
async function q(sql, params = []) {
    return query(sql, params);
}
exports.default = { query, q, pool: exports.pool };
