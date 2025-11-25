import { Router } from "express";
import { pool } from "../../../db";
import requireSession from "../../../middleware/requireSession";

const router = Router();

/**
 * SOAP Notes
 */
router.post("/notes", requireSession, async (req:any, res) => {
  try {
    const { encounter_id, subjective, objective, assessment, plan } = req.body;

    if (!encounter_id) return res.status(400).json({ error: "missing_encounter" });

    const { tenant_id, company_id, user_id } = req.session;

    const r = await pool.query(
      `INSERT INTO hms_notes
        (tenant_id, company_id, encounter_id, subjective, objective, assessment, plan, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id`,
      [tenant_id, company_id, encounter_id, subjective, objective, assessment, plan, user_id]
    );

    return res.json({ ok: true, note_id: r.rows[0].id });
  } catch (err) {
    console.error("NOTES ERROR:", err);
    return res.status(500).json({ error: "server_error" });
  }
});

export default router;
