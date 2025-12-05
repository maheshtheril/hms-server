// server/src/middleware/sessionLoader.ts
import { PoolClient } from "pg";
import { pool } from "../db"; // adjust if your db exports differently
import { parse as parseCookie } from "cookie";
import type { Request, Response, NextFunction } from "express";

/**
 * sessionLoader middleware (type-compatible)
 *
 * Notes:
 * - This file intentionally matches the existing `Express.Request.user` type
 *   used elsewhere in your codebase (so TypeScript won't complain).
 * - If your db module exports default (db.pool), change the import above:
 *     import db from "../db"; const pool = db.pool;
 */

/* env defaults */
const COOKIE_NAME = process.env.COOKIE_NAME_SID || process.env.SESSION_COOKIE_NAME || "sid";
const SESSIONS_TABLE_ENV = process.env.SESSIONS_TABLE || "sessions";
const SAFE_TABLE_NAME = /^[a-zA-Z0-9_]+$/.test(SESSIONS_TABLE_ENV) ? SESSIONS_TABLE_ENV : "sessions";

/* ---- Make our Request.user match the existing project shape ---- */
declare global {
  namespace Express {
    interface Request {
      // Keep exact shape mentioned in your error
      user?: {
        id: string;
        email: string;
        name: string;
        is_admin?: boolean;
        is_platform_admin?: boolean;
        is_tenant_admin?: boolean;
        roles?: string[];
        tenant_id?: string;
      };
      authSession?: {
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
      } | null;
      dbClient?: PoolClient | undefined;
    }
  }
}

/* safe release helper */
function safeRelease(client?: PoolClient | null) {
  try {
    if (client) client.release();
  } catch (_) {}
}

/**
 * Robust SID extraction helper
 * - uses cookie parser
 * - falls back to common legacy names (erp_session, session_id)
 * - accepts Bearer token
 * - also attempts raw header regex parse for edge cases
 */
function extractSidFromRequest(req: Request): string | null {
  try {
    const rawCookieHeader = String(req.headers?.cookie || "");
    // quick debug hint (not too noisy)
    // console.debug("[sessionLoader] raw-cookie-header:", rawCookieHeader ? "(present)" : "(none)");

    const parsed = parseCookie(rawCookieHeader || "");
    const canonical = COOKIE_NAME;

    // 1) canonical cookie name
    if (parsed[canonical]) {
      return String(parsed[canonical]);
    }

    // 2) fallback cookie names (legacy)
    const fallbacks = ["erp_session", "session_id", "SESSION_ID", "sid"];
    for (const k of fallbacks) {
      if (parsed[k]) return String(parsed[k]);
    }

    // 3) Authorization: Bearer <sid>
    if (typeof req.headers.authorization === "string" && req.headers.authorization.startsWith("Bearer ")) {
      return req.headers.authorization.split(" ")[1];
    }

    // 4) try regex on raw header (handles weird quoting or whitespace)
    if (rawCookieHeader) {
      const tryCanon = rawCookieHeader.match(new RegExp('(?:^|;\\s*)' + canonical + '=([^;\\s]+)'));
      if (tryCanon) return decodeURIComponent(tryCanon[1]);

      const tryErp = rawCookieHeader.match(/(?:^|;\s*)erp_session=([^;\\s]+)/);
      if (tryErp) return decodeURIComponent(tryErp[1]);
    }

    return null;
  } catch (err) {
    console.error("[sessionLoader] extractSidFromRequest error:", err);
    return null;
  }
}

export async function loadSessionOptional(req: Request, res: Response, next: NextFunction) {
  let client: PoolClient | null = null;
  let releaseHookAttached = false;

  try {
    if (!req || !req.headers) {
      req.authSession = undefined;
      return next();
    }

    const sid = extractSidFromRequest(req);

    if (!sid) {
      req.authSession = undefined;
      return next();
    }

    // Acquire DB client
    client = await (pool as any).connect();
    req.dbClient = client;

    // Attach release hook (so long-running requests still release client)
    const releaseClient = () => {
      try {
        if (releaseHookAttached) {
          safeRelease(req.dbClient);
          req.dbClient = undefined;
          res.removeListener("finish", releaseClient);
          res.removeListener("close", releaseClient);
          releaseHookAttached = false;
        }
      } catch (_) {}
    };
    res.on("finish", releaseClient);
    res.on("close", releaseClient);
    releaseHookAttached = true;

    const q = `
      SELECT s.sid, s.user_id, s.tenant_id AS session_tenant_id,
             u.email, u.name,
             u.is_admin, u.is_tenant_admin, u.is_platform_admin,
             u.is_active, u.tenant_id AS user_tenant_id, u.company_id,
             s.last_seen, s.issued_at
      FROM ${SAFE_TABLE_NAME} s
      JOIN app_user u ON u.id = s.user_id
      WHERE s.sid = $1
      LIMIT 1
    `;
    const { rows } = await client.query(q, [sid]);
    const row = rows?.[0];
    if (!row) {
      req.authSession = undefined;
      return next();
    }

    if (row.is_active === false) {
      req.authSession = undefined;
      return next();
    }

    const tenantId = row.session_tenant_id ?? row.user_tenant_id ?? null;
    const companyId = row.company_id ?? null;
    const userId = row.user_id ?? null;

    try {
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.company_id', $2, true), set_config('app.current_user_id', $3, true)",
        [tenantId, companyId, userId]
      );
    } catch (err) {
      console.warn("[sessionLoader] set_config failed:", err);
    }

    // Attach authSession (lightweight)
    req.authSession = {
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

    // IMPORTANT: set req.user with the exact expected shape (so TypeScript matches)
    req.user = {
      id: String(row.user_id),
      email: row.email,
      name: row.name,
      is_admin: !!row.is_admin,
      is_platform_admin: !!row.is_platform_admin,
      is_tenant_admin: !!row.is_tenant_admin,
      // roles and tenant_id are optional; keep tenant_id consistent with naming used elsewhere
      roles: undefined,
      tenant_id: tenantId ?? undefined,
    };

    return next();
  } catch (err: any) {
    console.error("[sessionLoader] loadSessionOptional error:", err?.stack ?? err);
    try {
      safeRelease(client ?? req.dbClient);
      req.dbClient = undefined;
    } catch (_) {}
    req.authSession = undefined;
    return next();
  }
}

export async function requireSession(req: Request, res: Response, next: NextFunction) {
  try {
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

export const sessionLoader = loadSessionOptional;
export default { loadSessionOptional, requireSession, sessionLoader };
