import { Router } from "express";
import { pool } from "../../../db";
import requireSession from "../../../middleware/requireSession";

const router = Router();

/**
 * POST /api/hms/lab/samples
 * Create or update a lab sample for an order line.
 */
router.post("/samples", requireSession, async (req: any, res) => {
  try {
    const { order_line_id, sample_type, barcode } = req.body;

    if (!order_line_id || !sample_type) {
      return res.status(400).json({ error: "missing_fields" });
    }

    const { tenant_id, company_id, user_id } = req.session;

    const r = await pool.query(
      `INSERT INTO hms_lab_sample
         (tenant_id, company_id, sample_type, sample_barcode, collected_at, collected_by)
       VALUES ($1,$2,$3,$4,now(),$5)
       RETURNING id`,
      [tenant_id, company_id, sample_type, barcode, user_id]
    );

    const sampleId = r.rows[0].id;

    await pool.query(
      `UPDATE hms_lab_order_line
       SET sample_id=$1
       WHERE id=$2`,
      [sampleId, order_line_id]
    );

    return res.json({ ok: true, sample_id: sampleId });

  } catch (err) {
    console.error("LAB SAMPLE ERROR:", err);
    return res.status(500).json({ error: "server_error" });
  }
});

export default router;
