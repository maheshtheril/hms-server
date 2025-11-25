import { Router } from "express";
import { pool } from "../../../db";
import requireSession from "../../../middleware/requireSession";

const router = Router();

/**
 * GET /api/hms/imaging/studies
 * Returns all imaging studies (X-ray, CT, MRI, USG, etc.)
 */
router.get("/", requireSession, async (req: any, res) => {
  try {
    const tenantId = req.session.tenant_id;
    const companyId = req.session.active_company_id;

    const { rows } = await pool.query(
      `SELECT 
         s.id,
         s.study_uid,
         s.modality,
         s.description,
         s.status,
         s.created_at,
         p.id AS patient_id,
         p.full_name AS patient_name,
         ord.id AS order_id
       FROM hms_imaging_study s
       JOIN hms_patient p ON p.id = s.patient_id
       JOIN hms_imaging_order ord ON ord.id = s.order_id
       WHERE s.tenant_id = $1 AND s.company_id = $2
       ORDER BY s.created_at DESC`,
      [tenantId, companyId]
    );

    res.json({ studies: rows });
  } catch (err: any) {
    console.error("[RIS] Failed to fetch imaging studies:", err);
    res.status(500).json({ error: "server_error", message: err.message });
  }
});

/**
 * GET /api/hms/imaging/studies/:id
 */
router.get("/:id", requireSession, async (req: any, res) => {
  try {
    const id = req.params.id;
    const tenantId = req.session.tenant_id;
    const companyId = req.session.active_company_id;

    const { rows } = await pool.query(
      `SELECT 
         s.*,
         p.full_name AS patient_name
       FROM hms_imaging_study s
       JOIN hms_patient p ON p.id = s.patient_id
       WHERE s.id = $1 AND s.tenant_id = $2 AND s.company_id = $3`,
      [id, tenantId, companyId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "not_found" });
    }

    res.json(rows[0]);
  } catch (err: any) {
    console.error("[RIS] Failed to fetch imaging study detail:", err);
    res.status(500).json({ error: "server_error", message: err.message });
  }
});

export default router;
