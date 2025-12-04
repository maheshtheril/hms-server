import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import { pool } from "../../../db";
import { createSession, buildSessionCookie } from "../../../lib/session";

const router = Router();

router.post("/", async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ error: "missing_fields" });
    }

    const emailLC = String(email).toLowerCase().trim();

    const client = await pool.connect();
    try {
      const r = await client.query(
        `SELECT id, password, tenant_id, company_id, is_active
         FROM app_user
         WHERE LOWER(email)=LOWER($1)
         LIMIT 1`,
        [emailLC]
      );

      if (r.rowCount === 0) {
        return res.status(401).json({ error: "invalid_credentials" });
      }

      const user = r.rows[0];

      if (!user.is_active) {
        return res.status(403).json({ error: "inactive_user" });
      }

      const ok = await bcrypt.compare(password, user.password);
      if (!ok) {
        return res.status(401).json({ error: "invalid_credentials" });
      }

      const sid = await createSession({
        userId: user.id,
        tenantId: user.tenant_id,
        companyId: user.company_id,
      });

      const cookieHeader = buildSessionCookie(sid);
      res.setHeader("Set-Cookie", cookieHeader);

      return res.status(200).json({
        ok: true,
        userId: user.id,
        tenantId: user.tenant_id,
        companyId: user.company_id,
      });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("[login] error:", err);
    return res.status(500).json({ error: "server_error" });
  }
});

export default router;
