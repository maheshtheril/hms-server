// server/src/routes/check-email.ts
import { Router } from "express";
import { pool } from "../db";

const router = Router();

router.get("/", async (req, res) => {
  try {
    const email = String(req.query.email || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ error: "missing_email" });

    const result = await pool.query(
      "SELECT id FROM public.app_user WHERE email=$1 LIMIT 1",
      [email]
    );

    const exists = result.rowCount > 0;
    return res.json({ exists });
  } catch (err) {
    console.error("[check-email] error:", err);
    return res.status(500).json({ error: "internal_error" });
  }
});

export default router;
