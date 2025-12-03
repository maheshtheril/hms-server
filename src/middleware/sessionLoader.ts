// server/src/middleware/sessionLoader.ts
import { PoolClient } from "pg";
import { pool } from "../db";
import { parse as parseCookie } from "cookie";
import type { Request, Response, NextFunction } from "express";

/* ------------------ ALWAYS USE sid ------------------ */
const COOKIE_NAME = "sid";

/* ------------------ SESSION TABLE ------------------ */
const SESSIONS_TABLE_ENV = process.env.SESSIONS_TABLE || "sessions";
const SAFE_TABLE_NAME = /^[a-zA-Z0-9_]+$/.test(SESSIONS_TABLE_ENV)
  ? SESSIONS_TABLE_ENV
  : "sessions";

/* ---- request type ---- */
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

export async function loadSessionOptional(
  req: Request,
  res: Response,
  next: NextFunction
) {
  let client: PoolClient | null = null;
  let releaseHookAttached = false;

  try {
    const cookies = parseCookie(req.headers.cookie || "");
    let sid = cookies[COOKIE_NAME] || null;

    // Fallback to alternative cookie names only for compatibility
    if (!sid) {
      const alt = ["session_id", "SESSION_ID", "erp_session", "sid"];
      for (const k of alt) {
        if (cookies[k]) {
          sid = cookies[k];
          break;
        }
      }
    }

    if (!sid) {
      req.authSession = undefined;
      return next();
    }

    client = await pool.connect();
    req.dbClient = client;

    const releaseClient = () => {
      if (releaseHookAttached) {
        safeRelease(req.dbClient);
        req.dbClient = undefined;
        res.removeListener("finish", releaseClient);
        res.removeListener("close", releaseClient);
        releaseHookAttached = false;
      }
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

    if (!row || row.is_active === false) {
      req.authSession = undefined;
      return next();
    }

    const tenantId = row.session_tenant_id ?? row.user_tenant_id ?? null;
    const companyId = row.company_id ?? null;

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

    req.user = {
      id: String(row.user_id),
      email: row.email,
      name: row.name,
      is_admin: !!row.is_admin,
      is_platform_admin: !!row.is_platform_admin,
      is_tenant_admin: !!row.is_tenant_admin,
      tenant_id: tenantId ?? undefined,
      roles: undefined,
    };

    return next();
  } catch (err: any) {
    console.error("[sessionLoader] error:", err);
    safeRelease(client);
    req.authSession = undefined;
    return next();
  }
}

export async function requireSession(
  req: Request,
  res: Response,
  next: NextFunction
) {
  await loadSessionOptional(req, res, () => {});
  if (!req.authSession?.user_id) {
    return res.status(401).json({ error: "unauthenticated" });
  }
  return next();
}

export const sessionLoader = loadSessionOptional;
export default { loadSessionOptional, requireSession, sessionLoader };
