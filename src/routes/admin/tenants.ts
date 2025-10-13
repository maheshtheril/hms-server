// server/src/routes/admin/tenants.ts
import { Router } from "express";
import { pool } from "../../db";
import bcrypt from "bcryptjs";
import { v4 as uuid } from "uuid";
import { sendVerifyEmail } from "../../services/mailer";
import { enqueueSeedJob } from "../../services/seeder";

const router = Router();

// choose a single origin source; fallback to localhost
const RAW_ORIGIN =
  process.env.APP_ORIGIN ||
  process.env.NEXT_PUBLIC_APP_ORIGIN ||
  process.env.FRONTEND_URL ||
  "http://localhost:3000";
const ORIGIN = RAW_ORIGIN.replace(/\/+$/, "");

router.post("/", async (req, res) => {
  const { org, name, email, password } = req.body || {};
  if (!org || !name || !email || !password) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tenantId = uuid();
    const userId = uuid();
    const companyId = uuid();
    const slug = org.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

    await client.query(
      `INSERT INTO tenants (id, name, slug, plan, status, created_at)
       VALUES ($1,$2,$3,'trial','pending_verification',now())`,
      [tenantId, org, slug]
    );

    const hash = await bcrypt.hash(password, 10);
    await client.query(
      `INSERT INTO users (id, tenant_id, name, email, password_hash, role, is_verified, created_at)
       VALUES ($1,$2,$3,$4,$5,'owner',false,now())`,
      [userId, tenantId, name, email, hash]
    );

    await client.query(
      `INSERT INTO companies (id, tenant_id, name, is_default, created_at)
       VALUES ($1,$2,$3,true,now())`,
      [companyId, tenantId, `${org} Main Company`]
    );

    // enqueue default seeds (roles, permissions, pipelines, settings)
    await enqueueSeedJob({ tenantId });

    // email verification
    const token = uuid();
    await client.query(
      `INSERT INTO verify_tokens (tenant_id, user_id, token, expires_at)
       VALUES ($1,$2,$3, now() + interval '2 day')`,
      [tenantId, userId, token]
    );
    await client.query("COMMIT");

    // Build verify URL for the email template
    const verifyUrl = `${ORIGIN}/verify?token=${encodeURIComponent(token)}`;

    await sendVerifyEmail({ to: email, name, verifyUrl }); // ✅ pass verifyUrl

    return res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    return res.status(500).json({ error: "Tenant creation failed" });
  } finally {
    client.release();
  }
});

export default router;
