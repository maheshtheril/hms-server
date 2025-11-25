import { Router } from "express";
import requireSession from "../../../middleware/requireSession";
import { pool } from "../../../db";

const router = Router();

// Create AI job
router.post("/tasks", requireSession, async (req:any, res) => {
  try {
    const { type, encounter_id, payload } = req.body;

    if (!type || !encounter_id)
      return res.status(400).json({ error: "missing_fields" });

    const { tenant_id, company_id, user_id } = req.session;

    const r = await pool.query(
      `INSERT INTO hms_ai_task
        (tenant_id, company_id, encounter_id, type, payload, status, created_by)
       VALUES ($1,$2,$3,$4,$5,'queued',$6)
       RETURNING id`,
      [tenant_id, company_id, encounter_id, type, payload, user_id]
    );

    return res.json({ ok: true, task_id: r.rows[0].id });

  } catch (err) {
    console.error("AI TASK ERROR:", err);
    return res.status(500).json({ error: "server_error" });
  }
});

export default router;
