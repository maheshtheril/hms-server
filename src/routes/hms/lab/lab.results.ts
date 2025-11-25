import { Router } from "express";
import { pool } from "../../../db";
import requireSession from "../../../middleware/requireSession";

const router = Router();

/**
 * POST /api/hms/lab/results
 * Submit a result for a test.
 */
router.post("/results", requireSession, async (req: any, res) => {
  try {
    const {
      order_line_id,
      test_id,
      result_value,
      numeric_value,
      units,
      interpreted_value,
      reference_range
    } = req.body;

    if (!order_line_id || !test_id) {
      return res.status(400).json({ error: "missing_fields" });
    }

    const { tenant_id, company_id, user_id } = req.session;

    const r = await pool.query(
      `INSERT INTO hms_lab_result
         (tenant_id, company_id, order_line_id, test_id, result_value,
          numeric_value, units, interpreted_value, reference_range,
          reported_by, reported_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
       RETURNING id`,
      [
        tenant_id,
        company_id,
        order_line_id,
        test_id,
        result_value ?? null,
        numeric_value ?? null,
        units ?? null,
        interpreted_value ?? null,
        reference_range ? JSON.stringify(reference_range) : null,
        user_id
      ]
    );

    return res.json({ ok: true, result_id: r.rows[0].id });

  } catch (err) {
    console.error("LAB RESULT ERROR:", err);
    return res.status(500).json({ error: "server_error" });
  }
});

export default router;
