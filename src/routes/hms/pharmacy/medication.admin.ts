import { Router } from "express";
import { pool } from "../../../db";
import requireSession from "../../../middleware/requireSession";

const router = Router();

// Record medication administration (MAR)
router.post("/admin", requireSession, async (req:any, res) => {
  try {
    const { medication_order_id, status, notes } = req.body;

    if (!medication_order_id || !status)
      return res.status(400).json({ error: "missing_fields" });

    const { tenant_id, company_id, user_id } = req.session;

    const r = await pool.query(
      `INSERT INTO hms_medication_administration
        (tenant_id, company_id, medication_order_id, status, notes, administered_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id`,
      [tenant_id, company_id, medication_order_id, status, notes, user_id]
    );

    return res.json({ ok: true, mar_id: r.rows[0].id });
  } catch (err) {
    console.error("MAR ERROR:", err);
    return res.status(500).json({ error: "server_error" });
  }
});

export default router;
