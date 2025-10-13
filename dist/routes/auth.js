"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = require("../db");
const crypto_1 = require("../lib/crypto");
const session_1 = require("../lib/session");
const cookies_1 = require("../lib/cookies");
const router = (0, express_1.Router)();
/**
 * POST /auth/login
 * Body: { email, password }
 */
router.post("/login", async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) {
        return res.status(400).json({ error: "missing_fields" });
    }
    // Fetch active user
    const { rows } = await (0, db_1.q)("SELECT * FROM app_user WHERE email = $1 AND is_active = true LIMIT 1", [email]);
    const user = rows[0];
    if (!user)
        return res.status(401).json({ error: "invalid_credentials" });
    // Verify password
    if (!user.password || !(0, crypto_1.compare)(password, user.password)) {
        return res.status(401).json({ error: "invalid_credentials" });
    }
    // Create a session
    const sid = await (0, session_1.issueSession)(user.id, user.tenant_id || null);
    (0, cookies_1.setCookie)(res, process.env.COOKIE_NAME_SID || "sid", sid);
    res.json({ ok: true });
});
/**
 * POST /auth/logout
 */
router.post("/logout", async (req, res) => {
    const sid = req.cookies?.[process.env.COOKIE_NAME_SID || "sid"];
    if (sid)
        await (0, session_1.revokeSession)(sid);
    (0, cookies_1.clearCookie)(res, process.env.COOKIE_NAME_SID || "sid");
    res.json({ ok: true });
});
/**
 * GET /auth/session
 * Returns current session + user info.
 */
router.get("/session", async (req, res) => {
    const sid = req.cookies?.[process.env.COOKIE_NAME_SID || "sid"];
    if (!sid)
        return res.json({ user: null });
    const { rows } = await (0, db_1.q)(`SELECT s.sid,
            u.id    AS user_id,
            u.email,
            u.name,
            u.is_admin,
            u.tenant_id,
            u.company_id
       FROM sessions s
       JOIN app_user u ON u.id = s.user_id
      WHERE s.sid = $1`, [sid]);
    res.json({ user: rows[0] || null });
});
exports.default = router;
