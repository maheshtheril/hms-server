"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = require("../db");
const requireAuth_1 = require("../middleware/requireAuth");
const router = (0, express_1.Router)();
/**
 * GET /api/me
 * Return the logged-in user's profile.
 */
router.get("/me", requireAuth_1.requireAuth, async (req, res) => {
    const sid = req.cookies?.[process.env.COOKIE_NAME_SID || "sid"];
    if (!sid)
        return res.status(401).json({ error: "unauthenticated" });
    // session object was attached by requireAuth
    const s = req.session;
    if (!s?.user_id)
        return res.status(401).json({ error: "unauthenticated" });
    const { rows } = await (0, db_1.q)(`SELECT id, email, name, is_admin, tenant_id, company_id
       FROM public.app_user
      WHERE id = $1
      LIMIT 1`, [s.user_id]);
    res.json({ user: rows[0] || null });
});
exports.default = router;
