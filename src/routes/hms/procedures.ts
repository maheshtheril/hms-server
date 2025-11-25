import { Router } from "express";
import { pool } from "../../db";
import requireSession from "../../middleware/requireSession";

const router = Router();

// Add a performed procedure
router.post("/procedures", requireSession, async (req:any, res) => {
  try {
    const { encounter_id, name, notes } = req.body;

    if (!encounter_id || !name)
      return res.status(400).json({ error: "missing_fields" });

    const { tenant_id, company_id, user_id } = req.session;

    const r = await pool.query(
      `INSERT INTO hms_procedure
        (tenant_id, company_id, encounter_id, name, notes, performed_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id`,
      [tenant_id, company_id, encounter_id, name, notes, user_id]
    );

    return res.json({ ok: true, procedure_id: r.rows[0].id });
  } catch (err) {
    console.error("PROCEDURE ERROR:", err);
    return res.status(500).json({ error: "server_error" });
  }
});

export default router;
