import { Router } from "express";
import { pool } from "../../../db";
import requireSession from "../../../middleware/requireSession";

const router = Router();

// Record vitals
router.post("/vitals", requireSession, async (req:any, res) => {
  try {
    const { encounter_id, bp, pulse, resp, temp, spo2, height, weight } = req.body;

    if (!encounter_id) return res.status(400).json({ error: "missing_encounter" });

    const { tenant_id, company_id, user_id } = req.session;

    const r = await pool.query(
      `INSERT INTO hms_vitals
        (tenant_id, company_id, encounter_id, bp, pulse, resp, temp, spo2, height, weight, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id`,
      [
        tenant_id, company_id, encounter_id,
        bp, pulse, resp, temp, spo2, height, weight,
        user_id
      ]
    );

    return res.json({ ok: true, vitals_id: r.rows[0].id });
  } catch (err) {
    console.error("VITALS ERROR:", err);
    return res.status(500).json({ error: "server_error" });
  }
});

export default router;
