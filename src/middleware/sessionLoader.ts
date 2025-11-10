// server/src/middleware/sessionLoader.ts
import db from "../db";
import { parse as parseCookie } from "cookie";
import { NextFunction } from "express";

const COOKIE_NAME = process.env.COOKIE_NAME_SID || "sid";

function coerceBool(v: any) {
  return v === true || v === "true" || v === 1 || v === "1" || v === "t";
}

/**
 * Load session if cookie present. Does NOT enforce authentication.
 * Attaches `req.session` (object) in all cases.
 * Very defensive: never throws, always attaches req.session.
 */
export async function loadSessionOptional(req: any, _res: any, next: NextFunction) {
  try {
    if (!req || !req.headers) {
      req.session = {};
      return next();
    }

    const cookies = parseCookie(req.headers.cookie || "");
    const sid = cookies[COOKIE_NAME] || null;
    if (!sid) {
      req.session = {};
      return next();
    }

    const q = `
      SELECT s.sid, s.user_id, s.tenant_id AS session_tenant_id,
             u.id as user_id_from_user, u.email, u.name,
             u.is_admin, u.is_tenant_admin, u.is_platform_admin,
             u.is_active, u.tenant_id AS user_tenant_id, u.company_id,
             s.last_seen, s.issued_at
      FROM sessions s
      JOIN app_user u ON u.id = s.user_id
      WHERE s.sid = $1
      LIMIT 1
    `;
    const { rows } = await db.query(q, [sid]);
    const row = rows?.[0];
    if (!row) {
      req.session = {};
      return next();
    }

    req.session = {
      sid: row.sid,
      user_id: row.user_id,
      tenant_id: row.session_tenant_id ?? row.user_tenant_id ?? null,
      company_id: row.company_id ?? null,
      is_admin: !!row.is_admin,
      is_tenant_admin: !!row.is_tenant_admin,
      is_platform_admin: !!row.is_platform_admin,
      email: row.email,
      name: row.name,
      issued_at: row.issued_at,
      last_seen: row.last_seen,
    };

    return next();
  } catch (err: any) {
    console.error("[sessionLoader] error (loadSessionOptional):", err?.stack ?? err);
    // degrade gracefully
    try { req.session = {}; } catch (_) {}
    return next();
  }
}

/**
 * Require a valid session or respond 401.
 * Attaches `req.session` when valid.
 */
export async function requireSession(req: any, res: any, next: NextFunction) {
  try {
    if (!req || !req.headers) return res.status(401).json({ error: "unauthenticated" });

    const cookies = parseCookie(req.headers.cookie || "");
    const sid = cookies[COOKIE_NAME] || null;
    if (!sid) return res.status(401).json({ error: "unauthenticated" });

    const q = `
      SELECT s.sid, s.user_id, s.tenant_id AS session_tenant_id,
             u.id as user_id_from_user, u.email, u.name,
             u.is_admin, u.is_tenant_admin, u.is_platform_admin,
             u.is_active, u.tenant_id AS user_tenant_id, u.company_id,
             s.last_seen, s.issued_at
      FROM sessions s
      JOIN app_user u ON u.id = s.user_id
      WHERE s.sid = $1
      LIMIT 1
    `;
    const { rows } = await db.query(q, [sid]);
    const row = rows?.[0];
    if (!row) return res.status(401).json({ error: "session_expired" });

    req.session = {
      sid: row.sid,
      user_id: row.user_id,
      tenant_id: row.session_tenant_id ?? row.user_tenant_id ?? null,
      company_id: row.company_id ?? null,
      is_admin: !!row.is_admin,
      is_tenant_admin: !!row.is_tenant_admin,
      is_platform_admin: !!row.is_platform_admin,
      email: row.email,
      name: row.name,
      issued_at: row.issued_at,
      last_seen: row.last_seen,
    };

    if (process.env.DEBUG_REQUIRE_SESSION) {
      console.log("[requireSession] parsed sid:", sid, "attached user:", req.session.user_id);
    }

    return next();
  } catch (err: any) {
    console.error("[sessionLoader] error (requireSession):", err?.stack ?? err);
    return res.status(500).json({ error: "internal_server_error" });
  }
}

/* Alias: provide a named export `sessionLoader` (points to optional loader) */
export const sessionLoader = loadSessionOptional;

/* Default export kept for backward compatibility */
export default { loadSessionOptional, requireSession, sessionLoader };
