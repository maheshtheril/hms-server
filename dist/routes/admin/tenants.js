"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// server/src/routes/admin/tenants.ts
const express_1 = require("express");
const db_1 = require("../../db");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const uuid_1 = require("uuid");
const mailer_1 = require("../../services/mailer");
const seeder_1 = require("../../services/seeder");
const router = (0, express_1.Router)();
// choose a single origin source; fallback to localhost
const RAW_ORIGIN = process.env.APP_ORIGIN ||
    process.env.NEXT_PUBLIC_APP_ORIGIN ||
    process.env.FRONTEND_URL ||
    "http://localhost:3000";
const ORIGIN = RAW_ORIGIN.replace(/\/+$/, "");
router.post("/", async (req, res) => {
    const { org, name, email, password } = req.body || {};
    if (!org || !name || !email || !password) {
        return res.status(400).json({ error: "Missing fields" });
    }
    const client = await db_1.pool.connect();
    try {
        await client.query("BEGIN");
        const tenantId = (0, uuid_1.v4)();
        const userId = (0, uuid_1.v4)();
        const companyId = (0, uuid_1.v4)();
        const slug = org.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
        await client.query(`INSERT INTO tenants (id, name, slug, plan, status, created_at)
       VALUES ($1,$2,$3,'trial','pending_verification',now())`, [tenantId, org, slug]);
        const hash = await bcryptjs_1.default.hash(password, 10);
        await client.query(`INSERT INTO users (id, tenant_id, name, email, password_hash, role, is_verified, created_at)
       VALUES ($1,$2,$3,$4,$5,'owner',false,now())`, [userId, tenantId, name, email, hash]);
        await client.query(`INSERT INTO companies (id, tenant_id, name, is_default, created_at)
       VALUES ($1,$2,$3,true,now())`, [companyId, tenantId, `${org} Main Company`]);
        // enqueue default seeds (roles, permissions, pipelines, settings)
        await (0, seeder_1.enqueueSeedJob)({ tenantId });
        // email verification
        const token = (0, uuid_1.v4)();
        await client.query(`INSERT INTO verify_tokens (tenant_id, user_id, token, expires_at)
       VALUES ($1,$2,$3, now() + interval '2 day')`, [tenantId, userId, token]);
        await client.query("COMMIT");
        // Build verify URL for the email template
        const verifyUrl = `${ORIGIN}/verify?token=${encodeURIComponent(token)}`;
        await (0, mailer_1.sendVerifyEmail)({ to: email, name, verifyUrl }); // ✅ pass verifyUrl
        return res.json({ ok: true });
    }
    catch (e) {
        await client.query("ROLLBACK");
        console.error(e);
        return res.status(500).json({ error: "Tenant creation failed" });
    }
    finally {
        client.release();
    }
});
exports.default = router;
