// server/src/db.ts
import "dotenv/config";
import pgPromise, { IMain, IDatabase } from "pg-promise";

const isProd = process.env.NODE_ENV === "production";

// Validate environment
const connectionString = process.env.DATABASE_URL || (isProd ? "" : process.env.DATABASE_URL);
if (isProd && !connectionString) {
  throw new Error("DATABASE_URL is required in production");
}

// Render PostgreSQL requires SSL
const ssl =
  connectionString && !/localhost|127\.0\.0\.1/.test(connectionString)
    ? { rejectUnauthorized: false }
    : undefined;

// -------------------------------------------------------------
// pg-promise initialization
// -------------------------------------------------------------
const initOptions = {
  // Optional debug:
  // query(e: any) { console.log("[SQL]", e.query); }
};

const pgp: IMain = pgPromise(initOptions);

// IMPORTANT:
// When SSL is needed, we must pass a config object.
// When SSL is NOT needed, passing a string is fine.
const db: IDatabase<any> =
  ssl
    ? pgp({
        connectionString,
        ssl,
      })
    : pgp(connectionString!);

// -------------------------------------------------------------
// Verify connectivity (non-blocking)
// -------------------------------------------------------------
(async () => {
  try {
    await db.one("SELECT 1");
    console.log(
      `[db] connected (ssl=${!!ssl}) env=${process.env.NODE_ENV}`
    );
  } catch (err: any) {
    console.error("[db] initial connection failed:", {
      message: err?.message,
      code: err?.code,
      detail: err?.detail,
      hint: err?.hint,
    });
  }
})();

export { pgp };
export default db;
