// server/src/routes/hmsDepartments.ts
import { Router, Request, Response, NextFunction } from "express";
import { q } from "../db"; // your existing query helper (returns { rows, rowCount } or similar)
import requireSession from "../middleware/requireSession"; // your middleware

const router = Router();

/* --------------------------- Utility helpers --------------------------- */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidUUID(v: any): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

function getRowCount(resLike: any): number {
  // q() may return pg result or a plain { rows } array wrapper
  if (resLike == null) return 0;
  if (typeof resLike.rowCount === "number") return resLike.rowCount;
  if (Array.isArray(resLike.rows)) return resLike.rows.length;
  if (Array.isArray(resLike)) return resLike.length;
  return 0;
}

/* --------------------------- Permissions --------------------------- */

/**
 * Simple write-permission guard:
 * allow if session has is_tenant_admin or is_admin or is_platform_admin
 * (you can adapt to role/permission system if you store roles on session)
 */
function requireWrite(req: Request, res: Response, next: NextFunction) {
  const ss = (req as any).session;
  if (!ss) return res.status(401).json({ error: "unauthenticated" });

  if (ss.is_tenant_admin || ss.is_admin || ss.is_platform_admin) {
    return next();
  }

  // Optional: check session.roles if populated
  // if (Array.isArray(ss.roles) && ss.roles.includes("hms_departments_write")) return next();

  return res.status(403).json({ error: "forbidden" });
}

/* --------------------------- Helpers for cycle prevention ---------------------------
  Minimal cycle protection: when assigning a parent_id, ensure:
   - parent_id !== id
   - parent_id exists and belongs to same tenant
   - parent_id is not a descendant of `id` (we walk up to depth limit)
  This prevents trivial cycles without complex graph algorithms.
--------------------------------------------------------------------------- */

const PARENT_DEPTH_LIMIT = 12;

async function parentBelongsToTenant(parentId: string, tenantId: string) {
  const pr = await q(`SELECT 1 FROM hms_department WHERE id = $1 AND tenant_id = $2 LIMIT 1`, [
    parentId,
    tenantId,
  ]);
  return getRowCount(pr) > 0;
}

async function isParentCycle(candidateParentId: string, childId: string, tenantId: string) {
  // Walk up the parent chain from candidateParentId; if we encounter childId, it's a cycle.
  let current = candidateParentId;
  for (let i = 0; i < PARENT_DEPTH_LIMIT; i++) {
    if (!isValidUUID(current)) break;
    if (current === childId) return true;

    const r = await q(`SELECT parent_id FROM hms_department WHERE id = $1 AND tenant_id = $2 LIMIT 1`, [
      current,
      tenantId,
    ]);
    if (getRowCount(r) === 0) break;
    const rowParent = r.rows?.[0]?.parent_id ?? null;
    if (!rowParent) break;
    // move up
    current = String(rowParent);
  }
  return false;
}

/* --------------------------- Routes --------------------------- */

/**
 * GET /api/hms/departments
 * Optional query: ?active=true|false
 */
router.get("/", requireSession, async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).session.tenant_id;
    const activeQ = req.query.active;
    const params: any[] = [tenantId];

    let where = `d.tenant_id = $1`;
    if (activeQ !== undefined) {
      params.push(activeQ === "true" || activeQ === "1");
      where += ` AND d.is_active = $${params.length}`;
    }

    const sql = `
      SELECT d.id,
             d.name,
             d.code,
             d.description,
             d.is_active,
             d.parent_id,
             p.name AS parent_name,
             d.created_at,
             d.updated_at
        FROM hms_department d
        LEFT JOIN hms_department p ON p.id = d.parent_id AND p.tenant_id = d.tenant_id
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
      SELECT d.id, d.name, d.code, d.description, d.is_active, d.parent_id, p.name AS parent_name,
             d.created_at, d.updated_at
        FROM hms_department d
        LEFT JOIN hms_department p ON p.id = d.parent_id AND p.tenant_id = d.tenant_id
       WHERE d.tenant_id = $1 AND d.id = $2
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
 * body: { name, code?, description?, parent_id?, is_active? }
 */
router.post("/", requireSession, requireWrite, async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).session.tenant_id;
    const actor = (req as any).session.user_id ?? null;
    const { name, code = null, description = null, parent_id = null, is_active = true } = req.body || {};

    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "invalid_name" });
    }

    if (parent_id !== null && parent_id !== undefined) {
      if (!isValidUUID(parent_id)) return res.status(400).json({ error: "invalid_parent_uuid" });

      const parentOk = await parentBelongsToTenant(parent_id, tenantId);
      if (!parentOk) return res.status(400).json({ error: "invalid_parent" });

      // Prevent trivial self-parenting (though id not set yet, early guard not necessary here).
      // No cycle possible at creation time unless client supplies parent_id equal to a new id (rare),
      // so we skip cycle check here because child id doesn't exist yet.
    }

    const insertSql = `
      INSERT INTO hms_department (tenant_id, name, code, description, parent_id, is_active, created_by, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, now())
      RETURNING id, tenant_id, name, code, description, parent_id, is_active, created_at, updated_at
    `;
    const r = await q(insertSql, [tenantId, name, code, description, parent_id, is_active, actor]);
    return res.status(201).json(r.rows?.[0] ?? null);
  } catch (err) {
    console.error("POST /api/hms/departments error:", err);
    return res.status(500).json({ error: "department_create_failed" });
  }
});

/**
 * PUT /api/hms/departments/:id  (full replace)
 */
router.put("/:id", requireSession, requireWrite, async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).session.tenant_id;
    const actor = (req as any).session.user_id ?? null;
    const id = req.params.id;
    const { name, code = null, description = null, parent_id = null, is_active = true } = req.body || {};

    if (!isValidUUID(id)) return res.status(400).json({ error: "invalid_id" });
    if (!name || typeof name !== "string") return res.status(400).json({ error: "invalid_name" });

    if (parent_id !== null && parent_id !== undefined) {
      if (!isValidUUID(parent_id)) return res.status(400).json({ error: "invalid_parent_uuid" });
      if (parent_id === id) return res.status(400).json({ error: "invalid_parent_self" });

      const parentOk = await parentBelongsToTenant(parent_id, tenantId);
      if (!parentOk) return res.status(400).json({ error: "invalid_parent" });

      const cycle = await isParentCycle(parent_id, id, tenantId);
      if (cycle) return res.status(400).json({ error: "invalid_parent_cycle" });
    }

    const updateSql = `
      UPDATE hms_department
         SET name = $1,
             code = $2,
             description = $3,
             parent_id = $4,
             is_active = $5,
             updated_by = $6,
             updated_at = now()
       WHERE tenant_id = $7 AND id = $8
       RETURNING id, tenant_id, name, code, description, parent_id, is_active, created_at, updated_at
    `;
    const r = await q(updateSql, [name, code, description, parent_id, is_active, actor, tenantId, id]);
    if (getRowCount(r) === 0) return res.status(404).json({ error: "not_found" });
    return res.json(r.rows?.[0] ?? null);
  } catch (err) {
    console.error("PUT /api/hms/departments/:id error:", err);
    return res.status(500).json({ error: "department_update_failed" });
  }
});

/**
 * PATCH /api/hms/departments/:id  (partial)
 */
router.patch("/:id", requireSession, requireWrite, async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).session.tenant_id;
    const actor = (req as any).session.user_id ?? null;
    const id = req.params.id;
    const patch = req.body || {};

    if (!isValidUUID(id)) return res.status(400).json({ error: "invalid_id" });

    // load existing
    const get = await q(`SELECT * FROM hms_department WHERE tenant_id = $1 AND id = $2 LIMIT 1`, [
      tenantId,
      id,
    ]);
    if (getRowCount(get) === 0) return res.status(404).json({ error: "not_found" });

    const current = get.rows[0];

    const name = patch.name ?? current.name;
    const code = patch.code !== undefined ? patch.code : current.code;
    const description = patch.description !== undefined ? patch.description : current.description;
    const parent_id = patch.parent_id !== undefined ? patch.parent_id : current.parent_id;
    const is_active = patch.is_active !== undefined ? patch.is_active : current.is_active;

    if (!name || typeof name !== "string") return res.status(400).json({ error: "invalid_name" });

    if (parent_id !== null && parent_id !== undefined) {
      if (!isValidUUID(parent_id)) return res.status(400).json({ error: "invalid_parent_uuid" });
      if (parent_id === id) return res.status(400).json({ error: "invalid_parent_self" });

      const parentOk = await parentBelongsToTenant(parent_id, tenantId);
      if (!parentOk) return res.status(400).json({ error: "invalid_parent" });

      const cycle = await isParentCycle(parent_id, id, tenantId);
      if (cycle) return res.status(400).json({ error: "invalid_parent_cycle" });
    }

    const updateSql = `
      UPDATE hms_department
         SET name = $1, code = $2, description = $3, parent_id = $4, is_active = $5, updated_by = $6, updated_at = now()
       WHERE tenant_id = $7 AND id = $8
       RETURNING id, tenant_id, name, code, description, parent_id, is_active, created_at, updated_at
    `;
    const r = await q(updateSql, [name, code, description, parent_id, is_active, actor, tenantId, id]);
    if (getRowCount(r) === 0) return res.status(404).json({ error: "not_found" });
    return res.json(r.rows?.[0] ?? null);
  } catch (err) {
    console.error("PATCH /api/hms/departments/:id error:", err);
    return res.status(500).json({ error: "department_patch_failed" });
  }
});

/**
 * DELETE /api/hms/departments/:id
 * Soft-delete: set is_active = false
 */
router.delete("/:id", requireSession, requireWrite, async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).session.tenant_id;
    const actor = (req as any).session.user_id ?? null;
    const id = req.params.id;

    if (!isValidUUID(id)) return res.status(400).json({ error: "invalid_id" });

    const r = await q(
      `UPDATE hms_department SET is_active = false, updated_by = $1, updated_at = now()
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
