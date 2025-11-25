import { Router } from "express";
import { pool } from "../../../db";
import requireSession from "../../../middleware/requireSession";

const router = Router();

// Create encounter
router.post("/encounters", requireSession, async (req:any, res) => {
  try {
    const { patient_id, visit_type = "opd", reason } = req.body;
    if (!patient_id) return res.status(400).json({ error: "missing_patient" });

    const { tenant_id, company_id, user_id } = req.session;

    const r = await pool.query(
      `INSERT INTO hms_encounter
        (tenant_id, company_id, patient_id, provider_id, visit_type, reason)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id`,
      [tenant_id, company_id, patient_id, user_id, visit_type, reason]
    );

    return res.json({ ok: true, encounter_id: r.rows[0].id });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "server_error" });
  }
});

export default router;
