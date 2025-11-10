// server/src/middleware/sessionLoader.ts
import db from "../db";
import cookie from "cookie";
import { NextFunction, Request, Response } from "express";

const COOKIE_NAME = process.env.COOKIE_NAME_SID || "sid";

function coerceBool(v: any) { return v === true || v === "true" || v === 1 || v === "1" || v === "t"; }

async function loadSessionOptional(req: any, _res: any, next: NextFunction) {
  try {
    const cookies = cookie.parse(req.headers.cookie || "");
    const sid = cookies[COOKIE_NAME] || null;
    if (!sid) { req.session = {}; return next(); }

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
    if (!row) { req.session = {}; return next(); }

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
  } catch (err) {
    return next(err);
  }
}

async function requireSession(req: any, res: any, next: NextFunction) {
  try {
    const cookies = cookie.parse(req.headers.cookie || "");
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

    // small debug to verify cookie reached this process (remove after)
    if (process.env.DEBUG_REQUIRE_SESSION) {
      console.log("[requireSession] parsed sid:", sid, "attached user:", req.session.user_id);
    }

    return next();
  } catch (err) {
    return next(err);
  }
}

export { loadSessionOptional, requireSession };
export default { loadSessionOptional, requireSession };
