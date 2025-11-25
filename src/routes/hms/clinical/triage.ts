import { Router } from "express";
import { pool } from "../../../db";
import requireSession from "../../../middleware/requireSession";

const router = Router();

router.post("/triage", requireSession, async (req:any, res) => {
  try {
    const { encounter_id, priority = "normal", notes } = req.body;

    if (!encounter_id) return res.status(400).json({ error: "missing_encounter" });

    const { tenant_id, company_id, user_id } = req.session;

    const r = await pool.query(
      `INSERT INTO hms_triage
        (tenant_id, company_id, encounter_id, priority, notes, triaged_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id`,
      [tenant_id, company_id, encounter_id, priority, notes, user_id]
    );

    return res.json({ ok: true, triage_id: r.rows[0].id });

  } catch (err) {
    console.error("TRIAGE ERROR:", err);
    return res.status(500).json({ error: "server_error" });
  }
});

export default router;
