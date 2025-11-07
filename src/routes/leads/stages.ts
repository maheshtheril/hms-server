// server/src/routes/leads/stages.ts
import { Router } from "express";
import db from "../../db"; // ← adjust path if needed

const router = Router();

/**
 * GET /api/leads/stages?pipeline_id=...
 * List stages for a pipeline (ordered)
 */
router.get("/", async (req, res, next) => {
  try {
    const pipeline_id = String(req.query.pipeline_id ?? "");
    if (!pipeline_id) return res.status(400).json({ error: "pipeline_id_required" });

    const { rows } = await db.query(
      `SELECT id, pipeline_id, tenant_id, name, "order", is_won, is_lost, is_active, default_probability, created_at
       FROM public.lead_stage
       WHERE pipeline_id = $1
       ORDER BY "order" ASC`,
      [pipeline_id]
    );
    return res.json({ data: rows });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /api/leads/stages
 * body: { pipeline_id, name, order?, is_won?, is_lost?, default_probability?, tenant_id? }
 */
router.post("/", async (req, res, next) => {
  try {
    if (!req.user?.is_admin) return res.status(403).json({ error: "forbidden" });
    const { pipeline_id, name, order, is_won, is_lost, default_probability, tenant_id } = req.body;
    if (!pipeline_id || !name) return res.status(400).json({ error: "pipeline_and_name_required" });

    const insert = `
      INSERT INTO public.lead_stage (pipeline_id, tenant_id, name, "order", is_won, is_lost, default_probability, created_at)
      VALUES ($1,$2,$3,$4,COALESCE($5,false),COALESCE($6,false),COALESCE($7,0),now())
      RETURNING id, pipeline_id, tenant_id, name, "order", is_won, is_lost, is_active, default_probability, created_at
    `;
    try {
      const { rows } = await db.query(insert, [pipeline_id, tenant_id ?? req.user?.tenant_id ?? null, name, order ?? 1000, is_won ?? false, is_lost ?? false, default_probability ?? 0]);
      return res.status(201).json({ data: rows[0] });
    } catch (e: any) {
      if (e.code === "23505") return res.status(409).json({ error: "duplicate_stage_name" });
      throw e;
    }
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /api/leads/stages/:id
 */
router.get("/:id", async (req, res, next) => {
  try {
    const { rows } = await db.query("SELECT id, pipeline_id, tenant_id, name, \"order\", is_won, is_lost, is_active, default_probability, created_at FROM public.lead_stage WHERE id=$1", [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: "not_found" });
    return res.json({ data: rows[0] });
  } catch (err) {
    return next(err);
  }
});

/**
 * PUT /api/leads/stages/:id
 */
router.put("/:id", async (req, res, next) => {
  try {
    if (!req.user?.is_admin) return res.status(403).json({ error: "forbidden" });

    const { name, order, is_won, is_lost, is_active, default_probability } = req.body;
    const { rows } = await db.query(
      `UPDATE public.lead_stage
       SET name=$1, "order" = COALESCE($2, "order"), is_won = COALESCE($3, is_won), is_lost = COALESCE($4, is_lost), is_active = COALESCE($5, is_active), default_probability = COALESCE($6, default_probability), updated_at = now()
       WHERE id=$7
       RETURNING id, pipeline_id, tenant_id, name, "order", is_won, is_lost, is_active, default_probability, created_at`,
      [name, order ?? null, typeof is_won === "boolean" ? is_won : null, typeof is_lost === "boolean" ? is_lost : null, typeof is_active === "boolean" ? is_active : null, typeof default_probability === "number" ? default_probability : null, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "not_found" });
    return res.json({ data: rows[0] });
  } catch (err) {
    return next(err);
  }
});

/**
 * DELETE /api/leads/stages/:id
 */
router.delete("/:id", async (req, res, next) => {
  try {
    if (!req.user?.is_admin) return res.status(403).json({ error: "forbidden" });
    await db.query("DELETE FROM public.lead_stage WHERE id=$1", [req.params.id]);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

export default router;
