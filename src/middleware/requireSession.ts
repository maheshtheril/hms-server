// server/src/middleware/requireSession.ts
import type { Request, Response, NextFunction } from "express";
import cookie from "cookie";
import { pool } from "../db";
import { findSessionBySid, touchSession } from "../services/sessionService";

// Narrow UUID v4-ish check (good enough for IDs we use)
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type SessionShape = {
  sid: string;
  user_id: string;
  tenant_id: string;
  active_company_id?: string | null;

  // hydrated flags (added; harmless if unused by callers)
  is_active?: boolean;
  is_admin?: boolean;
  is_tenant_admin?: boolean;
  is_platform_admin?: boolean;

  // optional identity fields (if you want to use later)
  email?: string;
  name?: string;
};

type CompanyCtx = {
  active_company_id: string | null;
};

// robust boolean coercion (handles true/false, "true"/"false", 1/0, 't'/'f')
const asBool = (v: any) =>
  v === true ||
  v === 1 ||
  v === "1" ||
  String(v).toLowerCase?.() === "true" ||
  String(v).toLowerCase?.() === "t";

/**
 * Require a valid session (sid or ssr_sid) AND hydrate company context + latest user flags.
 *
 * - Works with or without cookie-parser
 * - Accepts cookie names: sid, ssr_sid (also SESSION_ID / session_id as fallbacks)
 * - Attaches { sid, user_id, tenant_id, active_company_id, is_* flags } to req.session
 * - Attaches { active_company_id } to req.company
 * - Soft-refreshes session last_seen
 */
export default async function requireSession(
  req: Request & { session?: SessionShape; company?: CompanyCtx } & {
    // if cookie-parser present
    cookies?: Record<string, string>;
    signedCookies?: Record<string, string>;
  },
  res: Response,
  next: NextFunction
) {
  try {
    // Prefer cookie-parser if present; fall back to manual parse
    const parsed =
      (req as any).cookies ??
      (req.headers?.cookie ? cookie.parse(req.headers.cookie) : {});

    const sid =
      parsed?.sid ||
      parsed?.ssr_sid ||
      parsed?.SESSION_ID ||
      parsed?.session_id ||
      null;

    if (!sid) {
      return res.status(401).json({ error: "unauthenticated" });
    }

    const s = await findSessionBySid(String(sid));
    if (!s) {
      return res.status(401).json({ error: "session_expired" });
    }

    // Attach base session (without active company yet)
    (req as any).session = {
      sid: String(s.sid),
      user_id: String(s.user_id),
      tenant_id: String(s.tenant_id),
      active_company_id:
        (s as any).active_company_id != null
          ? String((s as any).active_company_id)
          : null,
    };

    const tenantId = (req as any).session.tenant_id;
    const userId = (req as any).session.user_id;

    const cx = await pool.connect();
    try {
      // ─────────────────────────────────────────────────────────────
      // 0) Hydrate latest user flags from DB (authoritative truth)
      // ─────────────────────────────────────────────────────────────
      const ures = await cx.query(
        `select id, tenant_id, email, name,
                coalesce(is_active,true)          as is_active,
                coalesce(is_admin,false)          as is_admin,
                coalesce(is_tenant_admin,false)   as is_tenant_admin,
                coalesce(is_platform_admin,false) as is_platform_admin
           from public.app_user
          where id = $1::uuid and tenant_id = $2::uuid
          limit 1`,
        [userId, tenantId]
      );
      if (ures.rowCount === 0) {
        return res.status(401).json({ error: "session_invalid" });
      }
      const u = ures.rows[0];

      // Overwrite/augment req.session with DB truth (coerced booleans)
      (req as any).session.email = String(u.email ?? "");
      (req as any).session.name = String(u.name ?? "");
      (req as any).session.is_active = asBool(u.is_active);
      (req as any).session.is_admin = asBool(u.is_admin);
      (req as any).session.is_tenant_admin = asBool(u.is_tenant_admin);
      (req as any).session.is_platform_admin = asBool(u.is_platform_admin);

      // Optional: debug header to quickly verify flags from the browser
      res.setHeader(
        "X-Debug-Session",
        JSON.stringify({
          tenant_id: tenantId,
          user_id: userId,
          is_platform_admin: (req as any).session.is_platform_admin,
          is_tenant_admin: (req as any).session.is_tenant_admin,
        })
      );

      // ─────────────────────────────────────────────────────────────
      // 1) Resolve/validate active company (kept as-is)
      // ─────────────────────────────────────────────────────────────
      let active: string | null =
        (req as any).session.active_company_id &&
        UUID_RE.test((req as any).session.active_company_id!)
          ? (req as any).session.active_company_id!
          : null;

      if (active) {
        const q = await cx.query(
          `select 1 from public.user_companies
            where tenant_id = $1 and user_id = $2 and company_id = $3`,
          [tenantId, userId, active]
        );
        if (q.rowCount === 0) active = null; // not allowed anymore
      }

      // If not set/invalid, see if the client sent an active_company_id cookie (unsigned OK)
      if (!active) {
        const cookieActive =
          (req as any).signedCookies?.active_company_id ??
          parsed?.active_company_id ??
          null;

        if (cookieActive && UUID_RE.test(String(cookieActive))) {
          // validate membership + tenant
          const ok = await cx.query(
            `select 1
               from public.user_companies uc
               join public.company c
                 on c.id = uc.company_id and c.tenant_id = uc.tenant_id
              where uc.tenant_id = $1 and uc.user_id = $2 and uc.company_id = $3`,
            [tenantId, userId, cookieActive]
          );
          if (ok.rowCount > 0) {
            active = String(cookieActive);
          }
        }
      }

      // If still empty, pick the user's default
      if (!active) {
        const def = await cx.query(
          `select company_id
             from public.user_companies
            where tenant_id = $1 and user_id = $2
            order by is_default desc, company_id asc
            limit 1`,
          [tenantId, userId]
        );
        active = def.rows[0]?.company_id ?? null;
      }

      // If still empty but user has exactly one mapping, use it
      if (!active) {
        const one = await cx.query(
          `select company_id
             from public.user_companies
            where tenant_id = $1 and user_id = $2
            order by company_id`,
          [tenantId, userId]
        );
        if (one.rowCount === 1) {
          active = one.rows[0].company_id as string;
        }
      }

      // Attach to req and session
      (req as any).company = { active_company_id: active ?? null };
      (req as any).session.active_company_id = active ?? null;

      // (Optional) mirror to cookie so the client can round-trip it (no need for cookie-parser)
      // Safe defaults; adjust domain/path as needed.
      res.cookie("active_company_id", active ?? "", {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      });
    } finally {
      cx.release();
    }

    // Soft-refresh last_seen but don't block the request if it fails
    touchSession(String(sid)).catch(() => {});

    return next();
  } catch (err) {
    return next(err);
  }
}
