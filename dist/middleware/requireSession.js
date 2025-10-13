"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = requireSession;
const cookie_1 = __importDefault(require("cookie"));
const db_1 = require("../db");
const sessionService_1 = require("../services/sessionService");
// Narrow UUID v4-ish check (good enough for IDs we use)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// robust boolean coercion (handles true/false, "true"/"false", 1/0, 't'/'f')
const asBool = (v) => v === true ||
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
async function requireSession(req, res, next) {
    try {
        // Prefer cookie-parser if present; fall back to manual parse
        const parsed = req.cookies ??
            (req.headers?.cookie ? cookie_1.default.parse(req.headers.cookie) : {});
        const sid = parsed?.sid ||
            parsed?.ssr_sid ||
            parsed?.SESSION_ID ||
            parsed?.session_id ||
            null;
        if (!sid) {
            return res.status(401).json({ error: "unauthenticated" });
        }
        const s = await (0, sessionService_1.findSessionBySid)(String(sid));
        if (!s) {
            return res.status(401).json({ error: "session_expired" });
        }
        // Attach base session (without active company yet)
        req.session = {
            sid: String(s.sid),
            user_id: String(s.user_id),
            tenant_id: String(s.tenant_id),
            active_company_id: s.active_company_id != null
                ? String(s.active_company_id)
                : null,
        };
        const tenantId = req.session.tenant_id;
        const userId = req.session.user_id;
        const cx = await db_1.pool.connect();
        try {
            // ─────────────────────────────────────────────────────────────
            // 0) Hydrate latest user flags from DB (authoritative truth)
            // ─────────────────────────────────────────────────────────────
            const ures = await cx.query(`select id, tenant_id, email, name,
                coalesce(is_active,true)          as is_active,
                coalesce(is_admin,false)          as is_admin,
                coalesce(is_tenant_admin,false)   as is_tenant_admin,
                coalesce(is_platform_admin,false) as is_platform_admin
           from public.app_user
          where id = $1::uuid and tenant_id = $2::uuid
          limit 1`, [userId, tenantId]);
            if (ures.rowCount === 0) {
                return res.status(401).json({ error: "session_invalid" });
            }
            const u = ures.rows[0];
            // Overwrite/augment req.session with DB truth (coerced booleans)
            req.session.email = String(u.email ?? "");
            req.session.name = String(u.name ?? "");
            req.session.is_active = asBool(u.is_active);
            req.session.is_admin = asBool(u.is_admin);
            req.session.is_tenant_admin = asBool(u.is_tenant_admin);
            req.session.is_platform_admin = asBool(u.is_platform_admin);
            // Optional: debug header to quickly verify flags from the browser
            res.setHeader("X-Debug-Session", JSON.stringify({
                tenant_id: tenantId,
                user_id: userId,
                is_platform_admin: req.session.is_platform_admin,
                is_tenant_admin: req.session.is_tenant_admin,
            }));
            // ─────────────────────────────────────────────────────────────
            // 1) Resolve/validate active company (kept as-is)
            // ─────────────────────────────────────────────────────────────
            let active = req.session.active_company_id &&
                UUID_RE.test(req.session.active_company_id)
                ? req.session.active_company_id
                : null;
            if (active) {
                const q = await cx.query(`select 1 from public.user_companies
            where tenant_id = $1 and user_id = $2 and company_id = $3`, [tenantId, userId, active]);
                if (q.rowCount === 0)
                    active = null; // not allowed anymore
            }
            // If not set/invalid, see if the client sent an active_company_id cookie (unsigned OK)
            if (!active) {
                const cookieActive = req.signedCookies?.active_company_id ??
                    parsed?.active_company_id ??
                    null;
                if (cookieActive && UUID_RE.test(String(cookieActive))) {
                    // validate membership + tenant
                    const ok = await cx.query(`select 1
               from public.user_companies uc
               join public.company c
                 on c.id = uc.company_id and c.tenant_id = uc.tenant_id
              where uc.tenant_id = $1 and uc.user_id = $2 and uc.company_id = $3`, [tenantId, userId, cookieActive]);
                    if (ok.rowCount > 0) {
                        active = String(cookieActive);
                    }
                }
            }
            // If still empty, pick the user's default
            if (!active) {
                const def = await cx.query(`select company_id
             from public.user_companies
            where tenant_id = $1 and user_id = $2
            order by is_default desc, company_id asc
            limit 1`, [tenantId, userId]);
                active = def.rows[0]?.company_id ?? null;
            }
            // If still empty but user has exactly one mapping, use it
            if (!active) {
                const one = await cx.query(`select company_id
             from public.user_companies
            where tenant_id = $1 and user_id = $2
            order by company_id`, [tenantId, userId]);
                if (one.rowCount === 1) {
                    active = one.rows[0].company_id;
                }
            }
            // Attach to req and session
            req.company = { active_company_id: active ?? null };
            req.session.active_company_id = active ?? null;
            // (Optional) mirror to cookie so the client can round-trip it (no need for cookie-parser)
            // Safe defaults; adjust domain/path as needed.
            res.cookie("active_company_id", active ?? "", {
                httpOnly: true,
                sameSite: "lax",
                secure: process.env.NODE_ENV === "production",
                maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
            });
        }
        finally {
            cx.release();
        }
        // Soft-refresh last_seen but don't block the request if it fails
        (0, sessionService_1.touchSession)(String(sid)).catch(() => { });
        return next();
    }
    catch (err) {
        return next(err);
    }
}
