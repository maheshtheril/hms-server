// server/src/middleware/sessionLoader.ts
import { PoolClient } from "pg";
import { pool } from "../db"; // adjust if your db exports differently
import { parse as parseCookie } from "cookie";
import type { Request, Response, NextFunction } from "express";

/* env defaults (align with index.ts canonical names) */
const COOKIE_NAME =
  process.env.SESSION_COOKIE_NAME ||
  process.env.COOKIE_NAME_SID ||
  process.env.COOKIE_NAME ||
  "sid";

const SESSIONS_TABLE_ENV = process.env.SESSIONS_TABLE || "sessions";
const SAFE_TABLE_NAME = /^[a-zA-Z0-9_]+$/.test(SESSIONS_TABLE_ENV) ? SESSIONS_TABLE_ENV : "sessions";

declare global {
  namespace Express {
    interface Request {
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

function safeRelease(client?: PoolClient | null) {
  try {
    if (client) client.release();
  } catch (_) {}
}

function extractSidFromRequest(req: Request): string | null {
  try {
    const rawCookieHeader = String(req.headers?.cookie || "");
    const parsed = parseCookie(rawCookieHeader || "");
    const canonical = COOKIE_NAME;

    if (parsed[canonical]) return String(parsed[canonical]);

    const fallbacks = ["erp_session", "session_id", "SESSION_ID", "sid"];
    for (const k of fallbacks) if (parsed[k]) return String(parsed[k]);

    if (typeof req.headers.authorization === "string" && req.headers.authorization.startsWith("Bearer ")) {
      return req.headers.authorization.split(" ")[1];
    }

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
    console.debug("[sessionLoader] sid:", sid ? `${sid.slice(0,12)}…` : "none");

    if (!sid) {
      req.authSession = undefined;
      return next();
    }

    // guard pool
    if (!pool || typeof (pool as any).connect !== "function") {
      console.error("[sessionLoader] DB pool is not available or malformed. Check ../db export.");
      req.authSession = undefined;
      return next();
    }

    client = await (pool as any).connect();
    req.dbClient = client;

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

    // attach listeners immediately and then flip flag
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
      LEFT JOIN app_user u ON u.id = s.user_id
      WHERE s.sid = $1
      LIMIT 1
    `;

    console.debug("[sessionLoader] querying session table:", SAFE_TABLE_NAME);
    const result = await client.query(q, [sid]);
    const row = result?.rows?.[0];

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
      console.warn("[sessionLoader] set_config failed (non-fatal):", err);
    }

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

    // Set req.user (expected shape)
    req.user = {
      id: String(row.user_id),
      email: row.email,
      name: row.name,
      is_admin: !!row.is_admin,
      is_platform_admin: !!row.is_platform_admin,
      is_tenant_admin: !!row.is_tenant_admin,
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
    // simpler/clearer invocation
    await loadSessionOptional(req, res, () => {});
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
