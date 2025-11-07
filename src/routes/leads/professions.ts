// server/src/routes/leads/professions.ts
import { Router } from "express";
import db from "../../db"; // <-- change path if your DB module is elsewhere

const router = Router();

/**
 * GET  /api/leads/professions?q=...
 * Returns list (tenant-scoped)
 */
router.get("/", async (req, res, next) => {
  try {
    const q = String(req.query.q ?? "");
    const tenantId = req.user?.tenant_id ?? null;

    const sql = `
      SELECT id, tenant_id, name, category, description, is_active, created_at
      FROM public.lead_profession
      WHERE ($1::uuid IS NULL OR tenant_id = $1)
        AND (name ILIKE $2)
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
 * POST /api/leads/professions
 * Create profession (admin-only)
 * body: { name, category?, description?, tenant_id? }
 */
router.post("/", async (req, res, next) => {
  try {
    if (!req.user?.is_admin) return res.status(403).json({ error: "forbidden" });

    const { name, category, description, tenant_id } = req.body;
    if (!name) return res.status(400).json({ error: "name_required" });

    const insert = `
      INSERT INTO public.lead_profession (tenant_id, name, category, description, created_at)
      VALUES ($1,$2,$3,$4,now())
      RETURNING id, tenant_id, name, category, description, is_active, created_at
    `;
    try {
      const { rows } = await db.query(insert, [tenant_id ?? req.user?.tenant_id ?? null, name, category ?? null, description ?? null]);
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
 * GET /api/leads/professions/:id
 */
router.get("/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    const { rows } = await db.query("SELECT id, tenant_id, name, category, description, is_active, created_at FROM public.lead_profession WHERE id = $1", [id]);
    if (rows.length === 0) return res.status(404).json({ error: "not_found" });
    return res.json({ data: rows[0] });
  } catch (err) {
    return next(err);
  }
});

/**
 * PUT /api/leads/professions/:id
 * body: { name, category?, description?, is_active? }
 */
router.put("/:id", async (req, res, next) => {
  try {
    if (!req.user?.is_admin) return res.status(403).json({ error: "forbidden" });

    const id = req.params.id;
    const { name, category, description, is_active } = req.body;

    const { rows } = await db.query(
      `UPDATE public.lead_profession SET name=$1, category=$2, description=$3, is_active = COALESCE($4, is_active), updated_at = now()
       WHERE id=$5 RETURNING id, tenant_id, name, category, description, is_active, created_at`,
      [name, category ?? null, description ?? null, typeof is_active === "boolean" ? is_active : null, id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "not_found" });
    return res.json({ data: rows[0] });
  } catch (err: any) {
    if (err.code === "23505") return res.status(409).json({ error: "duplicate_name" });
    return next(err);
  }
});

/**
 * DELETE /api/leads/professions/:id
 */
router.delete("/:id", async (req, res, next) => {
  try {
    if (!req.user?.is_admin) return res.status(403).json({ error: "forbidden" });
    const id = req.params.id;

    // safe delete: check for usage? Here we simply delete; you can decide to soft-deactivate instead.
    await db.query("DELETE FROM public.lead_profession WHERE id = $1", [id]);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

export default router;
