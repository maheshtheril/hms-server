import { Router } from "express";
import { q } from "../db";
import requireSession from "../middleware/requireSession";

const router = Router();

/**
 * GET /hms/patients
 */
router.get("/", requireSession, async (req, res) => {
  try {
    const { tenant_id } = req.session!;
    const { rows } = await q(
      `SELECT * FROM hms_patient WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenant_id]
    );
    res.json(rows);
  } catch (err) {
    console.error("GET /hms/patients:", err);
    res.status(500).json({ error: "fetch_failed" });
  }
});

/**
 * POST /hms/patients
 */
router.post("/", requireSession, async (req, res) => {
  try {
    const { tenant_id, user_id } = req.session!;
    const { name, dob, gender, phone } = req.body;

    const { rows } = await q(
      `INSERT INTO hms_patient (tenant_id, name, dob, gender, phone, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [tenant_id, name, dob, gender, phone, user_id]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error("POST /hms/patients:", err);
    res.status(500).json({ error: "create_failed" });
  }
});

/**
 * PUT /hms/patients/:id
 */
router.put("/:id", requireSession, async (req, res) => {
  try {
    const { tenant_id, user_id } = req.session!;
    const { id } = req.params;
    const { name, dob, gender, phone } = req.body;

    const { rows } = await q(
      `UPDATE hms_patient
          SET name=$1, dob=$2, gender=$3, phone=$4, updated_by=$5, updated_at=NOW()
        WHERE id=$6 AND tenant_id=$7
        RETURNING *`,
      [name, dob, gender, phone, user_id, id, tenant_id]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error("PUT /hms/patients:", err);
    res.status(500).json({ error: "update_failed" });
  }
});

/**
 * DELETE /hms/patients/:id
 */
router.delete("/:id", requireSession, async (req, res) => {
  try {
    const { tenant_id } = req.session!;
    const { id } = req.params;
    await q(`DELETE FROM hms_patient WHERE id=$1 AND tenant_id=$2`, [id, tenant_id]);
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /hms/patients:", err);
    res.status(500).json({ error: "delete_failed" });
  }
});

/**
 * AI HOOK: POST /hms/patients/ai/summary
 * - Input: patient_id
 * - Output: summary text (AI-ready stub)
 */
router.post("/ai/summary", requireSession, async (req, res) => {
  const { patient_id } = req.body;
  // Placeholder: In the future, connect to your LLM service.
  res.json({
    patient_id,
    summary: "[AI placeholder] Summary for patient will be generated here.",
  });
});

export default router;
