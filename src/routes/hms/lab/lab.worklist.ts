import { Router } from "express";
import { pool } from "../../../db";
import requireSession from "../../../middleware/requireSession";

const router = Router();

/**
 * GET /api/hms/lab/worklist
 * Returns all pending lab tasks for lab technicians.
 * A proper LIS always includes a worklist.
 */
router.get("/", requireSession, async (req: any, res) => {
  try {
    const tenantId = req.session.tenant_id;
    const companyId = req.session.active_company_id;

    const { rows } = await pool.query(
      `SELECT 
         o.id AS order_id,
         o.order_no,
         o.status,
         o.priority,
         o.created_at,
         p.id AS patient_id,
         p.full_name AS patient_name,
         lt.id AS test_id,
         lt.name AS test_name
       FROM hms_lab_order o
       JOIN hms_patient p ON p.id = o.patient_id
       JOIN hms_lab_order_item oi ON oi.order_id = o.id
       JOIN hms_lab_test lt ON lt.id = oi.test_id
       WHERE o.tenant_id = $1 
         AND o.company_id = $2
         AND o.status IN ('pending','accepted','collected')
       ORDER BY o.created_at ASC`,
      [tenantId, companyId]
    );

    res.json({ worklist: rows });
  } catch (err: any) {
    console.error("[LIS Worklist] Error:", err);
    res.status(500).json({ error: "server_error", message: err.message });
  }
});

export default router;
