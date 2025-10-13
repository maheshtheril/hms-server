import { Router } from "express";
import { q } from "../db";
import { requireAuth } from "../middleware/requireAuth";

const router = Router();

/**
 * GET /api/pipelines/:id/stages
 * Return all stages for a pipeline, ordered.
 */
router.get("/pipelines/:id/stages", requireAuth, async (req: any, res) => {
  const { id } = req.params;

  const { rows } = await q(
    `SELECT id, key, name, sort_order, is_won, is_lost
       FROM public.lead_stage
      WHERE pipeline_id = $1
      ORDER BY sort_order ASC, created_at ASC`,
    [id]
  );

  res.json(rows);
});

export default router;
