"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const cookie = __importStar(require("cookie"));
const db_1 = require("../db");
const sessionService_1 = require("../services/sessionService");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const asBool = (v) => v === true ||
    v === 1 ||
    v === "1" ||
    String(v).toLowerCase?.() === "true" ||
    String(v).toLowerCase?.() === "t";
// ✅ Non-async RequestHandler wrapper; do async work inside
const requireSession = (req, res, next) => {
    (async () => {
        const r = req;
        // Prefer cookie-parser if present; fall back to manual parse
        const parsed = r.cookies ?? (r.headers?.cookie ? cookie.parse(r.headers.cookie) : {});
        const sid = parsed?.sid || parsed?.ssr_sid || parsed?.SESSION_ID || parsed?.session_id || null;
        if (!sid) {
            // Helpful debug log for missing cookie (useful for mobile / CORS issues)
            console.warn("[requireSession] missing sid cookie. parsed cookies:", parsed, "origin:", req.headers.origin);
            res.status(401).json({ error: "unauthenticated" });
            return;
        }
        const s = await (0, sessionService_1.findSessionBySid)(String(sid));
        if (!s) {
            res.status(401).json({ error: "session_expired" });
            return;
        }
        r.session = {
            sid: String(s.sid),
            user_id: String(s.user_id),
            tenant_id: String(s.tenant_id),
            active_company_id: s.active_company_id != null ? String(s.active_company_id) : null,
        };
        const tenantId = r.session.tenant_id;
        const userId = r.session.user_id;
        const cx = await db_1.pool.connect();
        try {
            // 0) Hydrate latest user flags
            const ures = await cx.query(`select id, tenant_id, email, name,
                coalesce(is_active,true)          as is_active,
                coalesce(is_admin,false)          as is_admin,
                coalesce(is_tenant_admin,false)   as is_tenant_admin,
                coalesce(is_platform_admin,false) as is_platform_admin
           from public.app_user
          where id = $1::uuid and tenant_id = $2::uuid
          limit 1`, [userId, tenantId]);
            if ((ures?.rowCount ?? 0) === 0) {
                res.status(401).json({ error: "session_invalid" });
                return;
            }
            const u = ures.rows[0];
            r.session.email = String(u.email ?? "");
            r.session.name = String(u.name ?? "");
            r.session.is_active = asBool(u.is_active);
            r.session.is_admin = asBool(u.is_admin);
            r.session.is_tenant_admin = asBool(u.is_tenant_admin);
            r.session.is_platform_admin = asBool(u.is_platform_admin);
            res.setHeader("X-Debug-Session", JSON.stringify({
                tenant_id: tenantId,
                user_id: userId,
                is_platform_admin: r.session.is_platform_admin,
                is_tenant_admin: r.session.is_tenant_admin,
            }));
            // 1) Resolve/validate active company
            let active = r.session.active_company_id && UUID_RE.test(r.session.active_company_id)
                ? r.session.active_company_id
                : null;
            if (active) {
                const q = await cx.query(`select 1 from public.user_companies
            where tenant_id = $1 and user_id = $2 and company_id = $3`, [tenantId, userId, active]);
                if ((q?.rowCount ?? 0) === 0)
                    active = null;
            }
            if (!active) {
                const cookieActive = r.signedCookies?.active_company_id ?? parsed?.active_company_id ?? null;
                if (cookieActive && UUID_RE.test(String(cookieActive))) {
                    const ok = await cx.query(`select 1
               from public.user_companies uc
               join public.company c
                 on c.id = uc.company_id and c.tenant_id = uc.tenant_id
              where uc.tenant_id = $1 and uc.user_id = $2 and uc.company_id = $3`, [tenantId, userId, cookieActive]);
                    if ((ok?.rowCount ?? 0) > 0)
                        active = String(cookieActive);
                }
            }
            if (!active) {
                const def = await cx.query(`select company_id
             from public.user_companies
            where tenant_id = $1 and user_id = $2
            order by is_default desc, company_id asc
            limit 1`, [tenantId, userId]);
                active = def.rows[0]?.company_id ?? null;
            }
            if (!active) {
                const one = await cx.query(`select company_id
             from public.user_companies
            where tenant_id = $1 and user_id = $2
            order by company_id`, [tenantId, userId]);
                if ((one?.rowCount ?? 0) === 1) {
                    active = one.rows[0].company_id;
                }
            }
            r.company = { active_company_id: active ?? null };
            r.session.active_company_id = active ?? null;
            // Use environment-aware cookie options so mobile / cross-origin works correctly
            const isProd = process.env.NODE_ENV === "production";
            res.cookie("active_company_id", active ?? "", {
                httpOnly: true,
                sameSite: isProd ? "none" : "lax",
                secure: isProd,
                path: "/",
                maxAge: 30 * 24 * 60 * 60 * 1000,
            });
        }
        finally {
            cx.release();
        }
        // fire-and-forget
        (0, sessionService_1.touchSession)(String(sid)).catch(() => { });
        next();
    })().catch(next);
};
exports.default = requireSession;
