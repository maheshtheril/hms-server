// server/src/middleware/sessionLoader.ts
import { Request, Response, NextFunction } from "express";
import db from "../db";

const COOKIE_NAME = process.env.COOKIE_NAME_SID || "sid";
const DEBUG_SESSION = process.env.DEBUG_SESSION === "1" || false;

/** Normalized shapes exported for convenience */
export type SessionShape = {
  sid: string;
  user_id: string;
  tenant_id: string | null;
  company_id: string | null;
  is_admin: boolean;
  is_tenant_admin: boolean;
  is_platform_admin: boolean;
  email?: string | null;
  name?: string | null;
  issued_at?: string | null;
  last_seen?: string | null;
  meta?: any;
  [k: string]: any;
};

/** attach minimal session (if present) but don't fail — useful for routes that accept anonymous */
export async function loadSessionOptional(req: any, _res: Response, next: NextFunction) {
  try {
    const sid = req.cookies?.[COOKIE_NAME];
    if (!sid) return next();

    const q = `
      SELECT s.sid,
             s.user_id,
             s.tenant_id   AS session_tenant_id,
             s.meta        AS session_meta,
             s.last_seen,
             s.issued_at,
             u.email,
             u.name,
             u.is_admin,
             u.is_tenant_admin,
             u.is_platform_admin,
             u.is_active,
             u.tenant_id   AS user_tenant_id,
             u.company_id
      FROM sessions s
      JOIN app_user u ON u.id = s.user_id
      WHERE s.sid = $1
      LIMIT 1
    `;
    const { rows } = await db.query(q, [sid]);
    const row = rows?.[0];
    if (!row) {
      if (DEBUG_SESSION) console.log("[sessionLoader] optional: sid invalid/expired:", sid);
      return next();
    }

    const session: SessionShape = {
      sid: row.sid,
      user_id: row.user_id,
      tenant_id: row.session_tenant_id ?? row.user_tenant_id ?? null,
      company_id: row.company_id ?? null,
      is_admin: !!row.is_admin,
      is_tenant_admin: !!row.is_tenant_admin,
      is_platform_admin: !!row.is_platform_admin,
      email: row.email ?? null,
      name: row.name ?? null,
      issued_at: row.issued_at ?? null,
      last_seen: row.last_seen ?? null,
      meta: row.session_meta ?? {},
    };

    req.session = session;
    // also attach legacy req.user shape to be compatible with older code
    req.user = {
      id: session.user_id,
      tenant_id: session.tenant_id,
      company_id: session.company_id,
      is_admin: session.is_admin,
      is_tenant_admin: session.is_tenant_admin,
      is_platform_admin: session.is_platform_admin,
      email: session.email,
      name: session.name,
    };

    if (DEBUG_SESSION) console.log("[sessionLoader] optional attached session for", session.user_id);
    return next();
  } catch (err) {
    return next(err);
  }
}

/** require session: returns 401 when no valid session; attaches normalized req.session + req.user */
export async function requireSession(req: any, res: any, next: NextFunction) {
  try {
    const sid = req.cookies?.[COOKIE_NAME];
    if (!sid) {
      if (DEBUG_SESSION) console.log("[sessionLoader] require: no sid cookie");
      return res.status(401).json({ error: "unauthenticated" });
    }

    const q = `
      SELECT s.sid,
             s.user_id,
             s.tenant_id   AS session_tenant_id,
             s.meta        AS session_meta,
             s.last_seen,
             s.issued_at,
             u.email,
             u.name,
             u.is_admin,
             u.is_tenant_admin,
             u.is_platform_admin,
             u.is_active,
             u.tenant_id   AS user_tenant_id,
             u.company_id
      FROM sessions s
      JOIN app_user u ON u.id = s.user_id
      WHERE s.sid = $1
      LIMIT 1
    `;

    const { rows } = await db.query(q, [sid]);
    const row = rows?.[0];
    if (!row) {
      if (DEBUG_SESSION) console.log("[sessionLoader] require: sid not found or expired:", sid);
      return res.status(401).json({ error: "session_expired" });
    }

    const session: SessionShape = {
      sid: row.sid,
      user_id: row.user_id,
      tenant_id: row.session_tenant_id ?? row.user_tenant_id ?? null,
      company_id: row.company_id ?? null,
      is_admin: !!row.is_admin,
      is_tenant_admin: !!row.is_tenant_admin,
      is_platform_admin: !!row.is_platform_admin,
      email: row.email ?? null,
      name: row.name ?? null,
      issued_at: row.issued_at ?? null,
      last_seen: row.last_seen ?? null,
      meta: row.session_meta ?? {},
    };

    req.session = session;
    // attach legacy req.user shape so existing routes that read req.user continue to work
    req.user = {
      id: session.user_id,
      tenant_id: session.tenant_id,
      company_id: session.company_id,
      is_admin: session.is_admin,
      is_tenant_admin: session.is_tenant_admin,
      is_platform_admin: session.is_platform_admin,
      email: session.email,
      name: session.name,
    };

    if (DEBUG_SESSION) {
      console.log("[sessionLoader] require attached session for user:", session.user_id, {
        tenant: session.tenant_id,
        is_tenant_admin: session.is_tenant_admin,
        is_platform_admin: session.is_platform_admin,
      });
    }

    return next();
  } catch (err) {
    return next(err);
  }
}

/** convenience middleware to update last_seen asynchronously (non-blocking) */
export function touchSessionAsync(req: any) {
  try {
    const sid = req.session?.sid || req.cookies?.[COOKIE_NAME];
    if (!sid) return;
    // fire-and-forget; don't await
    db.query("UPDATE sessions SET last_seen = now() WHERE sid = $1", [sid]).catch((e: any) => {
      if (DEBUG_SESSION) console.warn("[sessionLoader] touch failed:", e?.message || e);
    });
  } catch { /* noop */ }
}

export default {
  requireSession,
  loadSessionOptional,
  touchSessionAsync,
};
