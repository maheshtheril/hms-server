import { Router } from "express";
import { pool } from "../../../db";
import requireSession from "../../../middleware/requireSession";

const router = Router();

router.post("/diagnosis", requireSession, async (req:any, res) => {
  try {
    const { encounter_id, code, description, is_primary = false } = req.body;

    if (!encounter_id || !code)
      return res.status(400).json({ error: "missing_fields" });

    const { tenant_id, company_id, user_id } = req.session;

    const r = await pool.query(
      `INSERT INTO hms_diagnosis
        (tenant_id, company_id, encounter_id, code, description, is_primary, diagnosed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id`,
      [tenant_id, company_id, encounter_id, code, description, is_primary, user_id]
    );

    return res.json({ ok: true, diagnosis_id: r.rows[0].id });
  } catch (err) {
    console.error("DIAGNOSIS ERROR:", err);
    return res.status(500).json({ error: "server_error" });
  }
});

export default router;
