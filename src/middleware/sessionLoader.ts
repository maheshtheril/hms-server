// src/middleware/sessionLoader.ts
import { Request, Response, NextFunction } from "express";
import db from "../db"; // adapt if your DB client export is different

export async function sessionLoader(req: Request & { session?: any }, res: Response, next: NextFunction) {
  try {
    const COOKIE_NAME = process.env.COOKIE_NAME_SID || "sid";
    const sid = req.cookies?.[COOKIE_NAME];

    if (!sid) {
      // not authenticated — don't error, just continue (routes can require session explicitly)
      return next();
    }

    const q = `
      SELECT s.sid,
             s.user_id,
             s.tenant_id   AS session_tenant_id,
             u.email,
             u.name,
             u.is_admin,
             u.is_tenant_admin,
             u.is_platform_admin,
             u.is_active,
             u.tenant_id   AS user_tenant_id,
             u.company_id,
             s.last_seen,
             s.issued_at
      FROM sessions s
      JOIN app_user u ON u.id = s.user_id
      WHERE s.sid = $1
      LIMIT 1
    `;

    const { rows } = await db.query(q, [sid]);
    const row = rows?.[0];

    if (!row) {
      // stale/invalid session — allow downstream to treat as unauthenticated
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

    // Optionally update last_seen asynchronously (non-blocking)
    db.query(`UPDATE sessions SET last_seen = now() WHERE sid = $1`, [sid]).catch(() => {});

    return next();
  } catch (err) {
    return next(err);
  }
}
