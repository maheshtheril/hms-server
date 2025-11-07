// server/src/routes/leads/pipelines.ts
import { Router } from "express";
import db from "..//..//db"; // ← adjust path if your DB module is elsewhere

const router = Router();

/**
 * GET /api/leads/pipelines?q=...
 * List pipelines for tenant (tenant_id from req.user or global)
 */
router.get("/", async (req, res, next) => {
  try {
    const q = String(req.query.q ?? "");
    const tenantId = req.user?.tenant_id ?? null;

    const sql = `
      SELECT id, tenant_id, name, description, is_active, created_at
      FROM public.lead_pipeline
      WHERE ($1::uuid IS NULL OR tenant_id = $1 OR tenant_id IS NULL)
        AND name ILIKE $2
      ORDER BY name
      LIMIT 1000
    `;
    const { rows } = await db.query(sql, [tenantId, `%${q}%`]);
    return res.json({ data: rows });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /api/leads/pipelines
 * body: { name, description, tenant_id? }
 */
router.post("/", async (req, res, next) => {
  try {
    if (!req.user?.is_admin) return res.status(403).json({ error: "forbidden" });

    const { name, description, tenant_id } = req.body;
    if (!name) return res.status(400).json({ error: "name_required" });

    const insert = `
      INSERT INTO public.lead_pipeline (tenant_id, name, description, created_at)
      VALUES ($1,$2,$3,now())
      RETURNING id, tenant_id, name, description, is_active, created_at
    `;
    try {
      const { rows } = await db.query(insert, [tenant_id ?? req.user?.tenant_id ?? null, name, description ?? null]);
      return res.status(201).json({ data: rows[0] });
    } catch (e: any) {
      if (e.code === "23505") return res.status(409).json({ error: "duplicate_name" });
      throw e;
    }
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /api/leads/pipelines/:id
 */
router.get("/:id", async (req, res, next) => {
  try {
    const { rows } = await db.query("SELECT id, tenant_id, name, description, is_active, created_at FROM public.lead_pipeline WHERE id=$1", [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: "not_found" });
    return res.json({ data: rows[0] });
  } catch (err) {
    return next(err);
  }
});

/**
 * PUT /api/leads/pipelines/:id
 */
router.put("/:id", async (req, res, next) => {
  try {
    if (!req.user?.is_admin) return res.status(403).json({ error: "forbidden" });
    const { name, description, is_active } = req.body;
    const { rows } = await db.query(
      `UPDATE public.lead_pipeline SET name=$1, description=$2, is_active = COALESCE($3, is_active), updated_at = now()
       WHERE id=$4 RETURNING id, tenant_id, name, description, is_active, created_at`,
      [name, description ?? null, typeof is_active === "boolean" ? is_active : null, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "not_found" });
    return res.json({ data: rows[0] });
  } catch (err: any) {
    if (err.code === "23505") return res.status(409).json({ error: "duplicate_name" });
    return next(err);
  }
});

/**
 * DELETE /api/leads/pipelines/:id
 */
router.delete("/:id", async (req, res, next) => {
  try {
    if (!req.user?.is_admin) return res.status(403).json({ error: "forbidden" });
    // deleting pipeline will cascade-delete stages by FK CASCADE
    await db.query("DELETE FROM public.lead_pipeline WHERE id=$1", [req.params.id]);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

export default router;
