import { Router } from "express";
import { pool } from "../../../db";
import requireSession from "../../../middleware/requireSession";

const router = Router();

// Create imaging request
router.post("/orders", requireSession, async (req:any, res) => {
  try {
    const { patient_id, encounter_id, modality, study_reason } = req.body;

    if (!patient_id || !modality)
      return res.status(400).json({ error: "missing_fields" });

    const { tenant_id, company_id, user_id } = req.session;

    const r = await pool.query(
      `INSERT INTO hms_imaging_order
        (tenant_id, company_id, patient_id, encounter_id, modality, reason, ordered_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id`,
      [tenant_id, company_id, patient_id, encounter_id, modality, study_reason, user_id]
    );

    return res.json({ ok: true, order_id: r.rows[0].id });
  } catch (err) {
    console.error("IMAGING ORDER ERROR:", err);
    return res.status(500).json({ error: "server_error" });
  }
});

export default router;
