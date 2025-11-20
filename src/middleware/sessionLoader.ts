// server/src/middleware/sessionLoader.ts
import { PoolClient } from "pg";
import db from "../db";
import { parse as parseCookie } from "cookie";
import type { Request, Response, NextFunction } from "express";

const COOKIE_NAME = process.env.COOKIE_NAME_SID || "sid";
const SESSIONS_TABLE = process.env.SESSIONS_TABLE || "sessions"; // adjust if different

function coerceBool(v: any) {
  return v === true || v === "true" || v === 1 || v === "1" || v === "t";
}

type AppSession = {
  sid?: string | null;
  user_id?: string | null;
  tenant_id?: string | null;
  company_id?: string | null;
  is_admin?: boolean;
  is_tenant_admin?: boolean;
  is_platform_admin?: boolean;
  email?: string | null;
  name?: string | null;
  issued_at?: string | null;
  last_seen?: string | null;
};

/**
 * Acquire a client and set session vars on that client so RLS using current_setting(...) works.
 * Attaches client to req.dbClient and lightweight auth context to req.authSession.
 * If you're also using express-session (server-side session store), we write into req.session.authSession for compatibility.
 *
 * IMPORTANT:
 * - Controllers/services should prefer req.dbClient (if present) for DB calls that rely on current_setting(...)
 * - Or use explicit tenant/company filters with req.authSession values and db.query
 */
export async function loadSessionOptional(req: Request, res: Response, next: NextFunction) {
  let client: PoolClient | null = null;
  try {
    if (!req || !req.headers) {
      req.authSession = undefined;
      return next();
    }

    const cookies = parseCookie(req.headers.cookie || "");
    const sid = cookies[COOKIE_NAME] || null;
    if (!sid) {
      req.authSession = undefined;
      return next();
    }

    // Acquire a client for the lifetime of the request so set_config is effective for subsequent queries.
    client = await (db.pool as any).connect();
    req.dbClient = client;

    const q = `
      SELECT s.sid, s.user_id, s.tenant_id AS session_tenant_id,
             u.email, u.name,
             u.is_admin, u.is_tenant_admin, u.is_platform_admin,
             u.is_active, u.tenant_id AS user_tenant_id, u.company_id,
             s.last_seen, s.issued_at
      FROM ${SESSIONS_TABLE} s
      JOIN app_user u ON u.id = s.user_id
      WHERE s.sid = $1
      LIMIT 1
    `;
    const { rows } = await client.query(q, [sid]);
    const row = rows?.[0];
    if (!row) {
      req.authSession = undefined;
      try { client.release(); } catch (_) {}
      req.dbClient = undefined;
      return next();
    }

    // Check user/session active flags if present
    if (row.is_active === false) {
      req.authSession = undefined;
      try { client.release(); } catch (_) {}
      req.dbClient = undefined;
      return next();
    }

    const tenantId = row.session_tenant_id ?? row.user_tenant_id ?? null;
    const companyId = row.company_id ?? null;
    const userId = row.user_id ?? null;

    // Set config on this client so RLS using current_setting(...) will work for subsequent queries over this client.
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.company_id', $2, true), set_config('app.current_user_id', $3, true)",
      [tenantId, companyId, userId]
    );

    // Attach a lightweight authSession on request
    const auth: AppSession = {
      sid: row.sid,
      user_id: row.user_id,
      tenant_id: tenantId,
      company_id: companyId,
      is_admin: !!row.is_admin,
      is_tenant_admin: !!row.is_tenant_admin,
      is_platform_admin: !!row.is_platform_admin,
      email: row.email,
      name: row.name,
      issued_at: row.issued_at,
      last_seen: row.last_seen,
    };
    req.authSession = auth;

    // If your app also uses express-session (server-side store), keep a copy in req.session.authSession for compatibility
    try {
      if ((req as any).session) {
        (req as any).session.authSession = auth;
      }
    } catch (_) {
      // ignore if req.session is not writable
    }

    // Also attach a lightweight req.user convenience object
    req.user = {
      id: row.user_id,
      email: row.email,
      name: row.name,
      is_admin: !!row.is_admin,
    };

    // Ensure the client is released when the response finishes (success or error).
    const releaseClient = () => {
      try { if (req.dbClient) { (req.dbClient as PoolClient).release(); req.dbClient = undefined; } } catch (err) { /* ignore */ }
      res.removeListener("finish", releaseClient);
      res.removeListener("close", releaseClient);
    };
    res.on("finish", releaseClient);
    res.on("close", releaseClient);

    return next();
  } catch (err: any) {
    console.error("[sessionLoader] loadSessionOptional error:", err?.stack ?? err);
    try { req.authSession = undefined; } catch (_) {}
    try { if (client) { client.release(); req.dbClient = undefined; } } catch (_) {}
    return next();
  }
}

/**
 * Require a valid session or respond 401.
 * Attaches `req.authSession` and `req.dbClient` when valid.
 */
export async function requireSession(req: Request, res: Response, next: NextFunction) {
  try {
    // Call loadSessionOptional and then check results
    await loadSessionOptional(req, res, () => Promise.resolve());
    if (!req.authSession || !req.authSession.user_id) {
      return res.status(401).json({ error: "unauthenticated" });
    }
    return next();
  } catch (err: any) {
    console.error("[sessionLoader] requireSession error:", err?.stack ?? err);
    return res.status(500).json({ error: "internal_server_error" });
  }
}

/* Backwards-compatible exports */
export const sessionLoader = loadSessionOptional;
export default { loadSessionOptional, requireSession, sessionLoader };
