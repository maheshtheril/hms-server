import { Router, Request, Response } from "express";
import { q } from "../db";
import requireSession from "../middleware/requireSession";
import { PoolClient } from "pg";

// Optional: reuse your departments’ requireWrite middleware or define inline
function requireWrite(req: Request, res: Response, next: Function) {
  const ss = (req as any).session;
  if (!ss) return res.status(401).json({ error: "unauthenticated" });

  if (ss.is_tenant_admin || ss.is_admin || ss.is_platform_admin) return next();

  return res.status(403).json({ error: "forbidden" });
}

const router = Router();

/* --------------------------- Utility helpers --------------------------- */

function normalizeResult(resLike: any) {
  if (!resLike) return { rows: [], rowCount: 0 };
  if (Array.isArray(resLike)) return { rows: resLike, rowCount: resLike.length };
  const rows = Array.isArray(resLike.rows) ? resLike.rows : [];
  const rowCount = typeof resLike.rowCount === "number" ? resLike.rowCount : rows.length;
  return { rows, rowCount };
}

/* --------------------------- Routes --------------------------- */

/**
 * GET /api/hms/specializations
 * Query params:
 *  - company_id (uuid)
 *  - search (string)
 *  - active (true/false)
 *  - limit (default 200)
 */
router.get("/", requireSession, async (req: Request, res: Response) => {
  try {
    const ss: any = (req as any).session;
    if (!ss || !ss.tenant_id) return res.status(401).json({ error: "unauthenticated" });

    const tenantId = String(ss.tenant_id);
    const rawCompany = Array.isArray(req.query.company_id) ? req.query.company_id[0] : req.query.company_id;
    const rawSearch = Array.isArray(req.query.search) ? req.query.search[0] : req.query.search;
    const rawActive = Array.isArray(req.query.active) ? req.query.active[0] : req.query.active;
    const rawLimit = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;

    const params: any[] = [tenantId];
    let where = "tenant_id = $1";

    if (rawCompany) {
      params.push(String(rawCompany).trim());
      where += ` AND (company_id = $${params.length} OR company_id IS NULL)`;
    }

    if (rawActive !== undefined && rawActive !== null) {
      const val = String(rawActive).trim().toLowerCase();
      const boolVal = val === "1" || val === "true";
      params.push(boolVal);
      where += ` AND is_active = $${params.length}`;
    }

    if (rawSearch && String(rawSearch).trim() !== "") {
      params.push(`%${String(rawSearch).trim().toLowerCase()}%`);
      where += ` AND lower(name) LIKE $${params.length}`;
    }

    const limit = rawLimit ? Math.min(parseInt(String(rawLimit), 10) || 200, 2000) : 200;
    params.push(limit);

    const sql = `
      SELECT id, tenant_id, company_id, name, description, is_active, created_at, updated_at
      FROM hms_specializations
      WHERE ${where}
      ORDER BY name
      LIMIT $${params.length}
    `;
    const r = await q(sql, params);
    const nr = normalizeResult(r);
    return res.json({ data: nr.rows ?? [], meta: { returned: nr.rowCount } });
  } catch (err) {
    console.error("GET /api/hms/specializations error:", err);
    return res.status(500).json({ error: "specializations_fetch_failed" });
  }
});

/**
 * GET /api/hms/specializations/:id
 */
router.get("/:id", requireSession, async (req: Request, res: Response) => {
  try {
    const ss: any = (req as any).session;
    if (!ss || !ss.tenant_id) return res.status(401).json({ error: "unauthenticated" });

    const tenantId = String(ss.tenant_id);
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "invalid_id" });

    const sql = `
      SELECT id, tenant_id, company_id, name, description, is_active, created_at, updated_at
      FROM hms_specializations
      WHERE tenant_id = $1 AND id = $2
      LIMIT 1
    `;
    const r = await q(sql, [tenantId, id]);
    const nr = normalizeResult(r);
    if (nr.rowCount === 0) return res.status(404).json({ error: "not_found" });
    return res.json(nr.rows[0]);
  } catch (err) {
    console.error("GET /api/hms/specializations/:id error:", err);
    return res.status(500).json({ error: "specialization_fetch_failed" });
  }
});

/**
 * POST /api/hms/specializations
 */
router.post("/", requireSession, requireWrite, async (req: Request, res: Response) => {
  try {
    const ss: any = (req as any).session;
    if (!ss || !ss.tenant_id) return res.status(401).json({ error: "unauthenticated" });

    const tenantId = String(ss.tenant_id);
    const actor = ss.user_id ?? null;
    const { company_id = null, name, description = null, is_active = true } = req.body || {};

    if (!name || String(name).trim() === "") return res.status(400).json({ error: "invalid_name" });
    if (String(name).length > 255) return res.status(400).json({ error: "name_too_long" });

    const insertSql = `
      INSERT INTO hms_specializations (tenant_id, company_id, name, description, is_active, created_at)
      VALUES ($1,$2,$3,$4,$5,now())
      RETURNING id, tenant_id, company_id, name, description, is_active, created_at, updated_at
    `;
    try {
      const r = await q(insertSql, [tenantId, company_id, String(name).trim(), description, is_active]);
      return res.status(201).json(r.rows?.[0] ?? null);
    } catch (err: any) {
      if (err && err.code === "23505") return res.status(409).json({ error: "specialization_conflict" });
      throw err;
    }
  } catch (err) {
    console.error("POST /api/hms/specializations error:", err);
    return res.status(500).json({ error: "specialization_create_failed" });
  }
});

/**
 * PUT /api/hms/specializations/:id (full update)
 */
router.put("/:id", requireSession, requireWrite, async (req: Request, res: Response) => {
  try {
    const ss: any = (req as any).session;
    if (!ss?.tenant_id) return res.status(401).json({ error: "unauthenticated" });

    const tenantId = String(ss.tenant_id);
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "invalid_id" });

    const { name, description = null, is_active = true } = req.body || {};
    if (!name || String(name).trim() === "") return res.status(400).json({ error: "invalid_name" });

    const sql = `
      UPDATE hms_specializations
      SET name=$1, description=$2, is_active=$3, updated_at=now()
      WHERE tenant_id=$4 AND id=$5
      RETURNING id, tenant_id, company_id, name, description, is_active, created_at, updated_at
    `;
    try {
      const r = await q(sql, [String(name).trim(), description, is_active, tenantId, id]);
      const nr = normalizeResult(r);
      if (nr.rowCount === 0) return res.status(404).json({ error: "not_found" });
      return res.json(nr.rows[0]);
    } catch (err: any) {
      if (err && err.code === "23505") return res.status(409).json({ error: "specialization_conflict" });
      throw err;
    }
  } catch (err) {
    console.error("PUT /api/hms/specializations/:id error:", err);
    return res.status(500).json({ error: "specialization_update_failed" });
  }
});

/**
 * PATCH /api/hms/specializations/:id (partial update)
 */
router.patch("/:id", requireSession, requireWrite, async (req: Request, res: Response) => {
  try {
    const ss: any = (req as any).session;
    if (!ss?.tenant_id) return res.status(401).json({ error: "unauthenticated" });

    const tenantId = String(ss.tenant_id);
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "invalid_id" });

    const patch = req.body || {};
    const get = await q(`SELECT * FROM hms_specializations WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
    const ng = normalizeResult(get);
    if (ng.rowCount === 0) return res.status(404).json({ error: "not_found" });

    const current = ng.rows[0];
    const name = patch.name !== undefined ? String(patch.name).trim() : current.name;
    const description = patch.description !== undefined ? patch.description : current.description;
    const is_active =
      patch.is_active !== undefined
        ? patch.is_active === true || patch.is_active === "true" || patch.is_active === 1 || patch.is_active === "1"
        : current.is_active;

    const sql = `
      UPDATE hms_specializations
      SET name=$1, description=$2, is_active=$3, updated_at=now()
      WHERE tenant_id=$4 AND id=$5
      RETURNING id, tenant_id, company_id, name, description, is_active, created_at, updated_at
    `;
    const r = await q(sql, [name, description, is_active, tenantId, id]);
    const nr = normalizeResult(r);
    return res.json(nr.rows[0]);
  } catch (err) {
    console.error("PATCH /api/hms/specializations/:id error:", err);
    return res.status(500).json({ error: "specialization_patch_failed" });
  }
});

/**
 * DELETE /api/hms/specializations/:id
 * Soft delete (set is_active=false)
 */
router.delete("/:id", requireSession, requireWrite, async (req: Request, res: Response) => {
  try {
    const ss: any = (req as any).session;
    if (!ss?.tenant_id) return res.status(401).json({ error: "unauthenticated" });

    const tenantId = String(ss.tenant_id);
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "invalid_id" });

    const sql = `
      UPDATE hms_specializations
      SET is_active=false, updated_at=now()
      WHERE tenant_id=$1 AND id=$2
      RETURNING id
    `;
    const r = await q(sql, [tenantId, id]);
    const nr = normalizeResult(r);
    if (nr.rowCount === 0) return res.status(404).json({ error: "not_found" });
    return res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/hms/specializations/:id error:", err);
    return res.status(500).json({ error: "specialization_delete_failed" });
  }
});

export default router;
