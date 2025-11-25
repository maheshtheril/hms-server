import { Router } from "express";
import { pool } from "../../../db";
import requireSession from "../../../middleware/requireSession";

const router = Router();

/**
 * POST /api/hms/lab/orders
 * Create a lab order with order lines.
 */
router.post("/orders", requireSession, async (req: any, res) => {
  try {
    const { tests = [], patient_id, encounter_id, clinical_notes, priority = "routine" } = req.body;

    if (!patient_id || tests.length === 0) {
      return res.status(400).json({ error: "missing_fields" });
    }

    const { tenant_id, company_id, user_id } = req.session;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Insert lab order
      const orderRes = await client.query(
        `INSERT INTO hms_lab_order
          (tenant_id, company_id, patient_id, encounter_id, ordered_by, priority, clinical_notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id`,
        [tenant_id, company_id, patient_id, encounter_id, user_id, priority, clinical_notes]
      );

      const orderId = orderRes.rows[0].id;

      // Insert order lines
      for (const testId of tests) {
        await client.query(
          `INSERT INTO hms_lab_order_line
            (tenant_id, company_id, order_id, test_id)
           VALUES ($1,$2,$3,$4)`,
          [tenant_id, company_id, orderId, testId]
        );
      }

      await client.query("COMMIT");
      return res.json({ ok: true, order_id: orderId });

    } catch (err) {
      await client.query("ROLLBACK");
      console.error("LAB ORDER ERROR:", err);
      return res.status(500).json({ error: "order_failed" });
    } finally {
      client.release();
    }

  } catch (err) {
    console.error("LAB ORDER SERVER ERROR:", err);
    return res.status(500).json({ error: "server_error" });
  }
});

export default router;
