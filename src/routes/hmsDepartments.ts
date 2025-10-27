// server/src/routes/hmsDepartments.ts
import { Router, Request, Response, NextFunction } from "express";
import { q } from "../db"; // your existing query helper
import requireSession from "../middleware/requireSession";

const router = Router();

/* --------------------------- Utility helpers --------------------------- */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidUUID(v: any): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

function getRowCount(resLike: any): number {
  if (resLike == null) return 0;
  if (typeof resLike.rowCount === "number") return resLike.rowCount;
  if (Array.isArray(resLike.rows)) return resLike.rows.length;
  if (Array.isArray(resLike)) return resLike.length;
  return 0;
}

/* --------------------------- Permissions --------------------------- */

function requireWrite(req: Request, res: Response, next: NextFunction) {
  const ss = (req as any).session;
  if (!ss) return res.status(401).json({ error: "unauthenticated" });

  if (ss.is_tenant_admin || ss.is_admin || ss.is_platform_admin) {
    return next();
  }

  // Optional role check:
  // if (Array.isArray(ss.roles) && ss.roles.includes("hms_departments_write")) return next();

  return res.status(403).json({ error: "forbidden" });
}

/* --------------------------- Cycle prevention helpers ---------------------------
   We enforce parent existence within same tenant and company and detect cycles
--------------------------------------------------------------------------- */

const PARENT_DEPTH_LIMIT = 12;

async function parentBelongsToTenantCompany(parentId: string, tenantId: string, companyId: string) {
  const pr = await q(
    `SELECT 1 FROM hms_departments WHERE id = $1 AND tenant_id = $2 AND company_id = $3 AND deleted_at IS NULL LIMIT 1`,
    [parentId, tenantId, companyId]
  );
  return getRowCount(pr) > 0;
}

async function isParentCycle(candidateParentId: string, childId: string, tenantId: string, companyId: string) {
  let current = candidateParentId;
  for (let i = 0; i < PARENT_DEPTH_LIMIT; i++) {
    if (!isValidUUID(current)) break;
    if (current === childId) return true;

    const r = await q(
      `SELECT parent_id FROM hms_departments WHERE id = $1 AND tenant_id = $2 AND company_id = $3 LIMIT 1`,
      [current, tenantId, companyId]
    );
    if (getRowCount(r) === 0) break;
    const rowParent = r.rows?.[0]?.parent_id ?? null;
    if (!rowParent) break;
    current = String(rowParent);
  }
  return false;
}

/* --------------------------- Routes --------------------------- */

/**
 * GET /api/hms/departments
 * Optional query params:
 *   ?company_id=<uuid>   (recommended - schema requires company_id not null)
 *   ?active=true|false   (filter by is_active)
 *   ?include_deleted=true (include soft-deleted rows)
 */
router.get("/", requireSession, async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).session.tenant_id;
    const companyId = req.query.company_id ?? null;
    const activeQ = req.query.active;
    const includeDeleted = req.query.include_deleted === "true";

    const params: any[] = [tenantId];
    let where = `d.tenant_id = $1`;

    if (companyId !== null) {
      if (!isValidUUID(companyId)) return res.status(400).json({ error: "invalid_company_id" });
      params.push(companyId);
      where += ` AND d.company_id = $${params.length}`;
    }

    if (activeQ !== undefined) {
      params.push(activeQ === "true" || activeQ === "1");
      where += ` AND d.is_active = $${params.length}`;
    }

    if (!includeDeleted) {
      where += ` AND d.deleted_at IS NULL`;
    }

    const sql = `
      SELECT d.id,
             d.tenant_id,
             d.company_id,
             d.name,
             d.code,
             d.description,
             d.is_active,
             d.parent_id,
             p.name AS parent_name,
             d.created_by,
             d.updated_by,
             d.created_at,
             d.updated_at,
             d.deleted_at
      FROM hms_departments d
      LEFT JOIN hms_departments p ON p.id = d.parent_id AND p.tenant_id = d.tenant_id AND p.company_id = d.company_id
      WHERE ${where}
      ORDER BY d.name
    `;

    const r = await q(sql, params);
    return res.json(r.rows ?? []);
  } catch (err) {
    console.error("GET /api/hms/departments error:", err);
    return res.status(500).json({ error: "departments_fetch_failed" });
  }
});

/**
 * GET /api/hms/departments/:id
 */
router.get("/:id", requireSession, async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).session.tenant_id;
    const id = req.params.id;

    if (!isValidUUID(id)) return res.status(400).json({ error: "invalid_id" });

    const sql = `
      SELECT d.id,
             d.tenant_id,
             d.company_id,
             d.name,
             d.code,
             d.description,
             d.is_active,
             d.parent_id,
             p.name AS parent_name,
             d.created_by,
             d.updated_by,
             d.created_at,
             d.updated_at,
             d.deleted_at
      FROM hms_departments d
      LEFT JOIN hms_departments p ON p.id = d.parent_id AND p.tenant_id = d.tenant_id AND p.company_id = d.company_id
      WHERE d.tenant_id = $1 AND d.id = $2 AND d.deleted_at IS NULL
      LIMIT 1
    `;
    const r = await q(sql, [tenantId, id]);
    if (getRowCount(r) === 0) return res.status(404).json({ error: "not_found" });
    return res.json(r.rows[0]);
  } catch (err) {
    console.error("GET /api/hms/departments/:id error:", err);
    return res.status(500).json({ error: "department_fetch_failed" });
  }
});

/**
 * POST /api/hms/departments
 * body: { name, company_id, code?, description?, parent_id?, is_active? }
 */
router.post("/", requireSession, requireWrite, async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).session.tenant_id;
    const actor = (req as any).session.user_id ?? null;
    const {
      name,
      company_id,
      code = null,
      description = null,
      parent_id = null,
      is_active = true,
    } = req.body || {};

    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "invalid_name" });
    }

    if (!company_id || !isValidUUID(company_id)) {
      return res.status(400).json({ error: "invalid_company_id" });
    }

    if (parent_id !== null && parent_id !== undefined) {
      if (!isValidUUID(parent_id)) return res.status(400).json({ error: "invalid_parent_uuid" });

      const parentOk = await parentBelongsToTenantCompany(parent_id, tenantId, company_id);
      if (!parentOk) return res.status(400).json({ error: "invalid_parent" });

      // No cycle check here because new row id unknown; cycles are impossible unless client
      // attempts to set parent equal to existing id they will later set as child — uncommon.
    }

    const insertSql = `
      INSERT INTO hms_departments
        (tenant_id, company_id, name, code, description, parent_id, is_active, created_by, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
      RETURNING id, tenant_id, company_id, name, code, description, parent_id, is_active, created_by, updated_by, created_at, updated_at, deleted_at
    `;
    const r = await q(insertSql, [tenantId, company_id, name, code, description, parent_id, is_active, actor]);
    return res.status(201).json(r.rows?.[0] ?? null);
  } catch (err) {
    // unique_company_code or fk_parent_company may throw here; surface helpful messages when possible
    console.error("POST /api/hms/departments error:", err);
    return res.status(500).json({ error: "department_create_failed" });
  }
});

/**
 * PUT /api/hms/departments/:id  (full replace)
 * body: { name, company_id, code?, description?, parent_id?, is_active? }
 *
 * NOTE: company_id is immutable in many designs; here we allow updating only if it remains same.
 */
router.put("/:id", requireSession, requireWrite, async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).session.tenant_id;
    const actor = (req as any).session.user_id ?? null;
    const id = req.params.id;
    const { name, company_id, code = null, description = null, parent_id = null, is_active = true } = req.body || {};

    if (!isValidUUID(id)) return res.status(400).json({ error: "invalid_id" });
    if (!name || typeof name !== "string") return res.status(400).json({ error: "invalid_name" });
    if (!company_id || !isValidUUID(company_id)) return res.status(400).json({ error: "invalid_company_id" });

    // Ensure target exists and belongs to tenant & company
    const existing = await q(`SELECT company_id FROM hms_departments WHERE tenant_id = $1 AND id = $2 LIMIT 1`, [
      tenantId,
      id,
    ]);
    if (getRowCount(existing) === 0) return res.status(404).json({ error: "not_found" });
    const existingCompany = existing.rows[0].company_id;
    if (existingCompany !== company_id) {
      // Prevent company transfer (safer default) — adjust if you want to allow moving departments across companies.
      return res.status(400).json({ error: "company_change_not_allowed" });
    }

    if (parent_id !== null && parent_id !== undefined) {
      if (!isValidUUID(parent_id)) return res.status(400).json({ error: "invalid_parent_uuid" });
      if (parent_id === id) return res.status(400).json({ error: "invalid_parent_self" });

      const parentOk = await parentBelongsToTenantCompany(parent_id, tenantId, company_id);
      if (!parentOk) return res.status(400).json({ error: "invalid_parent" });

      const cycle = await isParentCycle(parent_id, id, tenantId, company_id);
      if (cycle) return res.status(400).json({ error: "invalid_parent_cycle" });
    }

    const updateSql = `
      UPDATE hms_departments
         SET name = $1,
             code = $2,
             description = $3,
             parent_id = $4,
             is_active = $5,
             updated_by = $6,
             updated_at = now()
       WHERE tenant_id = $7 AND id = $8 AND company_id = $9
       RETURNING id, tenant_id, company_id, name, code, description, parent_id, is_active, created_by, updated_by, created_at, updated_at, deleted_at
    `;
    const r = await q(updateSql, [name, code, description, parent_id, is_active, actor, tenantId, id, company_id]);
    if (getRowCount(r) === 0) return res.status(404).json({ error: "not_found" });
    return res.json(r.rows?.[0] ?? null);
  } catch (err) {
    console.error("PUT /api/hms/departments/:id error:", err);
    return res.status(500).json({ error: "department_update_failed" });
  }
});

/**
 * PATCH /api/hms/departments/:id  (partial)
 * body: partial fields; company_id must match existing one if provided
 */
router.patch("/:id", requireSession, requireWrite, async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).session.tenant_id;
    const actor = (req as any).session.user_id ?? null;
    const id = req.params.id;
    const patch = req.body || {};

    if (!isValidUUID(id)) return res.status(400).json({ error: "invalid_id" });

    const get = await q(`SELECT * FROM hms_departments WHERE tenant_id = $1 AND id = $2 LIMIT 1`, [tenantId, id]);
    if (getRowCount(get) === 0) return res.status(404).json({ error: "not_found" });

    const current = get.rows[0];

    const name = patch.name ?? current.name;
    const code = patch.code !== undefined ? patch.code : current.code;
    const description = patch.description !== undefined ? patch.description : current.description;
    const parent_id = patch.parent_id !== undefined ? patch.parent_id : current.parent_id;
    const is_active = patch.is_active !== undefined ? patch.is_active : current.is_active;
    const company_id = patch.company_id !== undefined ? patch.company_id : current.company_id;

    if (!name || typeof name !== "string") return res.status(400).json({ error: "invalid_name" });
    if (!company_id || !isValidUUID(company_id)) return res.status(400).json({ error: "invalid_company_id" });

    // prevent company change unless you explicitly support it
    if (company_id !== current.company_id) {
      return res.status(400).json({ error: "company_change_not_allowed" });
    }

    if (parent_id !== null && parent_id !== undefined) {
      if (!isValidUUID(parent_id)) return res.status(400).json({ error: "invalid_parent_uuid" });
      if (parent_id === id) return res.status(400).json({ error: "invalid_parent_self" });

      const parentOk = await parentBelongsToTenantCompany(parent_id, tenantId, company_id);
      if (!parentOk) return res.status(400).json({ error: "invalid_parent" });

      const cycle = await isParentCycle(parent_id, id, tenantId, company_id);
      if (cycle) return res.status(400).json({ error: "invalid_parent_cycle" });
    }

    const updateSql = `
      UPDATE hms_departments
         SET name = $1,
             code = $2,
             description = $3,
             parent_id = $4,
             is_active = $5,
             updated_by = $6,
             updated_at = now()
       WHERE tenant_id = $7 AND id = $8 AND company_id = $9
       RETURNING id, tenant_id, company_id, name, code, description, parent_id, is_active, created_by, updated_by, created_at, updated_at, deleted_at
    `;
    const r = await q(updateSql, [name, code, description, parent_id, is_active, actor, tenantId, id, company_id]);
    if (getRowCount(r) === 0) return res.status(404).json({ error: "not_found" });
    return res.json(r.rows?.[0] ?? null);
  } catch (err) {
    console.error("PATCH /api/hms/departments/:id error:", err);
    return res.status(500).json({ error: "department_patch_failed" });
  }
});

/**
 * DELETE /api/hms/departments/:id
 * Soft-delete by setting deleted_at (and marking inactive)
 */
router.delete("/:id", requireSession, requireWrite, async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).session.tenant_id;
    const actor = (req as any).session.user_id ?? null;
    const id = req.params.id;

    if (!isValidUUID(id)) return res.status(400).json({ error: "invalid_id" });

    const r = await q(
      `UPDATE hms_departments
          SET is_active = false, deleted_at = now(), updated_by = $1, updated_at = now()
        WHERE tenant_id = $2 AND id = $3
      RETURNING id`,
      [actor, tenantId, id]
    );
    if (getRowCount(r) === 0) return res.status(404).json({ error: "not_found" });
    return res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/hms/departments/:id error:", err);
    return res.status(500).json({ error: "department_delete_failed" });
  }
});

export default router;
