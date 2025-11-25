import { Router } from "express";
import { pool } from "../../../db";
import requireSession from "../../../middleware/requireSession";

const router = Router();

// Medication Order (Prescription)
router.post("/orders", requireSession, async (req:any, res) => {
  try {
    const { encounter_id, product_id, dose, frequency, duration, route, notes } = req.body;

    if (!encounter_id || !product_id || !dose)
      return res.status(400).json({ error: "missing_fields" });

    const { tenant_id, company_id, user_id } = req.session;

    const r = await pool.query(
      `INSERT INTO hms_medication_order
        (tenant_id, company_id, encounter_id, product_id, dose, frequency, duration, route, notes, ordered_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id`,
      [tenant_id, company_id, encounter_id, product_id, dose, frequency, duration, route, notes, user_id]
    );

    return res.json({ ok: true, medication_order_id: r.rows[0].id });
  } catch (err) {
    console.error("MED ORDER ERROR:", err);
    return res.status(500).json({ error: "server_error" });
  }
});

export default router;
