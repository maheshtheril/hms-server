// src/middleware/sessionLoader.ts
import { RequestHandler, Request, Response, NextFunction } from "express";
import db from "../db";

const DEBUG = process.env.NODE_ENV !== "production";

/**
 * A RequestHandler that also exposes named middleware properties.
 * This matches code that does:
 *   import sessionLoader from "./middleware/sessionLoader";
 *   app.use(sessionLoader.loadSessionOptional)
 *
 * or:
 *   import { requireSession } from "./middleware/sessionLoader";
 */
export interface SessionLoader extends RequestHandler {
  loadSessionOptional: RequestHandler;
  requireSession: RequestHandler;
}

/* ---------- helpers ---------- */
function coerceBool(v: any): boolean {
  return v === true || v === "true" || v === 1 || v === "1" || v === "t";
}

/* ---------- loadSessionOptional ---------- */
const loadSessionOptional: RequestHandler = async (req: any, _res: Response, next: NextFunction) => {
  try {
    const COOKIE_NAME = process.env.COOKIE_NAME_SID || "sid";
    const sid = req.cookies?.[COOKIE_NAME];
    if (!sid) {
      if (DEBUG) console.log("[sessionLoader] no sid cookie — continuing (optional)");
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
      if (DEBUG) console.log("[sessionLoader] sid not found or expired:", sid);
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

    if (DEBUG) {
      console.log("[sessionLoader] attached session for user:", req.session.user_id, {
        tenant: req.session.tenant_id,
        is_tenant_admin: req.session.is_tenant_admin,
        is_platform_admin: req.session.is_platform_admin,
      });
    }

    return next();
  } catch (err) {
    return next(err);
  }
};

/* ---------- requireSession (enforce) ---------- */
const requireSession: RequestHandler = async (req: any, res: Response, next: NextFunction) => {
  try {
    // Ensure optional loader runs first (it mutates req.session)
    await new Promise<void>((resolve, reject) => {
      loadSessionOptional(req, res, (err?: any) => (err ? reject(err) : resolve()));
    });

    if (!req.session || !req.session.user_id) {
      if (DEBUG) console.log("[requireSession] missing session -> 401");
      return res.status(401).json({ error: "unauthenticated" });
    }
    return next();
  } catch (err) {
    return next(err);
  }
};

/* ---------- typed default export with properties ---------- */
/**
 * Create a default function that behaves like loadSessionOptional and
 * has both named middlewares as properties. Typed as SessionLoader so TS
 * recognizes the properties.
 */
const sessionLoader = (async (req: Request, res: Response, next: NextFunction) => {
  return loadSessionOptional(req as any, res, next);
}) as unknown as SessionLoader;

sessionLoader.loadSessionOptional = loadSessionOptional;
sessionLoader.requireSession = requireSession;

/* ---------- exports ---------- */
export { loadSessionOptional, requireSession, sessionLoader };
export default sessionLoader;
