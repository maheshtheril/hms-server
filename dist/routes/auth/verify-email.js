"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// server/src/routes/auth/verify-email.ts
const express_1 = require("express");
const db_1 = require("../../db");
const router = (0, express_1.Router)();
router.get("/", async (req, res) => {
    const token = String(req.query.token || "");
    if (!token)
        return res.status(400).send("Missing token");
    const client = await db_1.pool.connect();
    try {
        await client.query("BEGIN");
        const q = await client.query(`SELECT tenant_id, user_id FROM verify_tokens
       WHERE token=$1 AND expires_at > now() LIMIT 1`, [token]);
        if (!q.rowCount) {
            await client.query("ROLLBACK");
            return res.status(400).send("Invalid or expired token");
        }
        const { tenant_id, user_id } = q.rows[0];
        await client.query(`UPDATE users SET is_verified=true WHERE id=$1`, [user_id]);
        await client.query(`UPDATE tenants SET status='active' WHERE id=$1 AND status='pending_verification'`, [tenant_id]);
        await client.query(`DELETE FROM verify_tokens WHERE token=$1`, [token]);
        await client.query("COMMIT");
        // create session cookies
        req.session.user_id = user_id;
        req.session.tenant_id = tenant_id;
        return res.redirect(process.env.APP_BASE_URL + "/dashboard");
    }
    catch (e) {
        await client.query("ROLLBACK");
        console.error(e);
        return res.status(500).send("Verification failed");
    }
    finally {
        client.release();
    }
});
exports.default = router;
