"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// server/src/routes/auth.ts
const express_1 = require("express");
const db_1 = require("../db");
const crypto_1 = require("../lib/crypto");
const session_1 = require("../lib/session");
const router = (0, express_1.Router)();
/**
 * Small helper: cookie name and env-aware options
 */
const COOKIE_NAME = process.env.COOKIE_NAME_SID || "sid";
const isProd = process.env.NODE_ENV === "production";
function cookieOptions() {
    return {
        httpOnly: true,
        secure: isProd, // true in production (HTTPS), false in local dev
        sameSite: isProd ? "none" : "lax",
        path: "/",
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    };
}
/**
 * POST /auth/login
 * Body: { email, password }
 */
router.post("/login", async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) {
        return res.status(400).json({ error: "missing_fields" });
    }
    const emailLc = String(email).trim().toLowerCase();
    // Fetch active user (email normalized)
    const { rows } = await (0, db_1.q)("SELECT * FROM app_user WHERE lower(email) = $1 AND is_active = true LIMIT 1", [emailLc]);
    const user = rows[0];
    if (!user)
        return res.status(401).json({ error: "invalid_credentials" });
    // Verify password
    if (!user.password || !(0, crypto_1.compare)(password, user.password)) {
        return res.status(401).json({ error: "invalid_credentials" });
    }
    // Create a session (store tenant_id if you have it on user)
    const sid = await (0, session_1.issueSession)(user.id, user.tenant_id || null);
    // Set cookie with explicit options so mobile & cross-origin clients behave
    res.cookie(COOKIE_NAME, sid, cookieOptions());
    // helpful debug header (optional)
    res.setHeader("X-Auth-User", String(user.id));
    res.json({ ok: true });
});
/**
 * POST /auth/logout
 */
router.post("/logout", async (req, res) => {
    const sid = req.cookies?.[COOKIE_NAME];
    if (sid)
        await (0, session_1.revokeSession)(sid);
    // Clear cookie using same path / sameSite settings — important for some browsers
    res.clearCookie(COOKIE_NAME, {
        path: "/",
        sameSite: isProd ? "none" : "lax",
        secure: isProd,
    });
    res.json({ ok: true });
});
/**
 * GET /auth/session
 * Returns current session + user info.
 */
router.get("/session", async (req, res) => {
    const sid = req.cookies?.[COOKIE_NAME];
    if (!sid)
        return res.json({ user: null });
    const { rows } = await (0, db_1.q)(`SELECT s.sid,
            s.tenant_id        AS session_tenant_id,
            u.id               AS user_id,
            u.email,
            u.name,
            u.is_admin,
            u.is_tenant_admin,
            u.is_platform_admin,
            u.is_active,
            u.tenant_id        AS user_tenant_id,
            u.company_id
       FROM sessions s
       JOIN app_user u ON u.id = s.user_id
      WHERE s.sid = $1
      LIMIT 1`, [sid]);
    const row = rows[0];
    if (!row)
        return res.json({ user: null });
    res.json({
        user: {
            id: row.user_id,
            email: row.email,
            name: row.name,
            is_admin: !!row.is_admin,
            is_tenant_admin: !!row.is_tenant_admin,
            is_platform_admin: !!row.is_platform_admin,
            is_active: !!row.is_active,
            tenant_id: row.session_tenant_id || row.user_tenant_id || null,
            company_id: row.company_id || null,
        },
    });
});
/**
 * GET /auth/me — used by the web app after login
 * Returns flags + tenant-scoped roles (and optionally permissions)
 */
router.get("/me", async (req, res) => {
    const sid = req.cookies?.[COOKIE_NAME];
    if (!sid)
        return res.json({ user: null, roles: [], tenant: null });
    // 1) Load session + user flags
    const { rows } = await (0, db_1.q)(`SELECT s.sid,
            s.user_id,
            s.tenant_id              AS session_tenant_id,
            u.email,
            u.name,
            u.is_admin,
            u.is_tenant_admin,
            u.is_platform_admin,
            u.is_active,
            u.tenant_id              AS user_tenant_id,
            u.company_id
       FROM sessions s
       JOIN app_user u ON u.id = s.user_id
      WHERE s.sid = $1
      LIMIT 1`, [sid]);
    const row = rows[0];
    if (!row)
        return res.json({ user: null, roles: [], tenant: null });
    // 2) Resolve tenant context (priority: session → user.company → user.tenant → default mapping)
    let tenantId = row.session_tenant_id || row.user_tenant_id || null;
    if (!tenantId && row.company_id) {
        const t = await (0, db_1.q)(`SELECT tenant_id FROM company WHERE id = $1 LIMIT 1`, [
            row.company_id,
        ]);
        tenantId = t.rows[0]?.tenant_id || null;
    }
    if (!tenantId) {
        const t2 = await (0, db_1.q)(`SELECT tenant_id
         FROM user_companies
        WHERE user_id = $1 AND is_default IS TRUE
        LIMIT 1`, [row.user_id]);
        tenantId = t2.rows[0]?.tenant_id || null;
    }
    // 3) Tenant-scoped roles
    let roleKeys = [];
    if (tenantId) {
        const r = await (0, db_1.q)(`SELECT r.key
         FROM user_role ur
         JOIN role r ON r.id = ur.role_id
        WHERE ur.user_id = $1 AND ur.tenant_id = $2`, [row.user_id, tenantId]);
        roleKeys = r.rows.map((x) => x.key);
    }
    // 4) (Optional) Aggregate permissions for this tenant
    let permissions = [];
    if (tenantId) {
        const p = await (0, db_1.q)(`SELECT DISTINCT rp.permission_code
         FROM user_role ur
         JOIN role_permission rp ON rp.role_id = ur.role_id
        WHERE ur.user_id = $1
          AND ur.tenant_id = $2
          AND rp.is_granted = TRUE`, [row.user_id, tenantId]);
        permissions = p.rows.map((x) => x.permission_code);
    }
    // 5) Shape for the frontend Sidebar (snake_case flags kept)
    return res.json({
        user: {
            id: row.user_id,
            email: row.email,
            name: row.name,
            is_admin: !!row.is_admin,
            is_tenant_admin: !!row.is_tenant_admin,
            is_platform_admin: !!row.is_platform_admin,
            is_active: !!row.is_active,
            roles: roleKeys,
            permissions,
            tenant_id: tenantId,
            company_id: row.company_id || null,
        },
        roles: roleKeys,
        tenant: tenantId ? { id: tenantId } : null,
    });
});
// inside server/src/routes/auth.ts (add near other auth handlers)
router.get("/last-login", async (req, res) => {
    try {
        const sid = req.cookies?.[process.env.COOKIE_NAME_SID || "sid"];
        if (!sid)
            return res.status(404).json({ error: "no_session" });
        const { rows } = await (0, db_1.q)(`SELECT u.id, u.email, s.last_active_at
         FROM sessions s
         JOIN app_user u ON u.id = s.user_id
        WHERE s.sid = $1
        LIMIT 1`, [sid]);
        if (!rows[0])
            return res.status(404).json({ error: "not_found" });
        return res.json({ last_login: rows[0].last_active_at || null });
    }
    catch (err) {
        console.error("GET /api/auth/last-login error:", err);
        return res.status(500).json({ error: "last_login_failed" });
    }
});
exports.default = router;
