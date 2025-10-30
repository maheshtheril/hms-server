"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// server/src/routes/check-email.ts
const express_1 = require("express");
const db_1 = require("../db");
const router = (0, express_1.Router)();
router.get("/", async (req, res) => {
    try {
        const email = String(req.query.email || "").trim().toLowerCase();
        if (!email)
            return res.status(400).json({ error: "missing_email" });
        const result = await db_1.pool.query("SELECT id FROM public.app_user WHERE email=$1 LIMIT 1", [email]);
        const exists = result.rowCount > 0;
        return res.json({ exists });
    }
    catch (err) {
        console.error("[check-email] error:", err);
        return res.status(500).json({ error: "internal_error" });
    }
});
exports.default = router;
