import { Router } from "express";
// Adjust this import to your DB client. Example: import db from "../db";
import db from "../../db"; // <-- replace with your actual DB module

const router = Router();

/**
 * GET  /api/leads/sources?q=...
 * Returns list (tenant-scoped). Replace tenant extraction with your auth/session.
 */
router.get("/", async (req, res, next) => {
  try {
    const q = String(req.query.q ?? "");
    // derive tenant from req.user (your auth middleware should set it)
    const tenantId = req.user?.tenant_id ?? null;

    const sql = `
      SELECT id, tenant_id, key, name, config, created_at
      FROM public.lead_source
      WHERE ($1::uuid IS NULL OR tenant_id = $1 OR tenant_id IS NULL)
        AND (name ILIKE $2 OR key ILIKE $2)
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
 * POST /api/leads/sources
 * Create new source
 * body: { key, name, config, tenant_id? }
 *
 * Permission model:
 * - platform admins can create global or tenant-scoped sources
 * - tenant admins can create sources scoped to their tenant only
 */
router.post("/", async (req, res, next) => {
  try {
    // Quick debug log (remove in production if you don't want verbose logs)
    console.log("POST /api/leads/sources called by:", req.user?.id, "userFlags:", {
      is_platform_admin: req.user?.is_platform_admin,
      is_tenant_admin: req.user?.is_tenant_admin,
      tenant_id: req.user?.tenant_id,
    });

    const isPlatformAdmin = !!req.user?.is_platform_admin;
    const isTenantAdmin = !!req.user?.is_tenant_admin;

    if (!isPlatformAdmin && !isTenantAdmin) {
      return res.status(403).json({ error: "forbidden" });
    }

    const { key, name, config } = req.body;
    // tenant_id: prefer explicit body, fall back to user's tenant
    let tenant_id = req.body?.tenant_id ?? req.user?.tenant_id ?? null;

    // tenant admins cannot create for other tenants (safety)
    if (isTenantAdmin && tenant_id && req.user?.tenant_id && tenant_id !== req.user.tenant_id) {
      return res.status(403).json({ error: "forbidden_tenant_mismatch" });
    }

    if (!key || !name) return res.status(400).json({ error: "key_and_name_required" });

    const insert = `
      INSERT INTO public.lead_source (tenant_id, key, name, config, created_at)
      VALUES ($1,$2,$3,$4, now())
      RETURNING id, tenant_id, key, name, config, created_at
    `;
    try {
      const { rows } = await db.query(insert, [tenant_id ?? null, key, name, config ?? {}]);
      return res.status(201).json({ data: rows[0] });
    } catch (e: any) {
      if (e.code === "23505") return res.status(409).json({ error: "duplicate_key_or_name" });
      throw e;
    }
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /api/leads/sources/:id
 */
router.get("/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    const { rows } = await db.query("SELECT id, tenant_id, key, name, config, created_at FROM public.lead_source WHERE id = $1", [id]);
    if (rows.length === 0) return res.status(404).json({ error: "not_found" });
    return res.json({ data: rows[0] });
  } catch (err) {
    return next(err);
  }
});

/**
 * PUT /api/leads/sources/:id
 * body: { key, name, config }
 *
 * NOTE: currently still restricted to platform admins.
 * If you want tenant admins to update sources in their tenant, we can relax this check similarly.
 */
router.put("/:id", async (req, res, next) => {
  try {
    if (!req.user?.is_admin && !req.user?.is_platform_admin) return res.status(403).json({ error: "forbidden" });

    const id = req.params.id;
    const { key, name, config } = req.body;
    const { rows } = await db.query(
      `UPDATE public.lead_source SET key=$1, name=$2, config=$3, updated_at = now() WHERE id=$4 RETURNING id, tenant_id, key, name, config, created_at`,
      [key, name, config ?? {}, id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "not_found" });
    return res.json({ data: rows[0] });
  } catch (err: any) {
    if (err.code === "23505") return res.status(409).json({ error: "duplicate_key_or_name" });
    return next(err);
  }
});

/**
 * DELETE /api/leads/sources/:id
 */
router.delete("/:id", async (req, res, next) => {
  try {
    if (!req.user?.is_admin && !req.user?.is_platform_admin) return res.status(403).json({ error: "forbidden" });
    const id = req.params.id;
    await db.query("DELETE FROM public.lead_source WHERE id = $1", [id]);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

export default router;
