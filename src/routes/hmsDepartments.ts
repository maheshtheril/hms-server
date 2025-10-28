import { Router, Request, Response, NextFunction } from "express";
import { q } from "../db";
import requireSession from "../middleware/requireSession";

const router = Router();

/* --------------------------- Utility helpers --------------------------- */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidUUID(v: any): v is string {
  return typeof v === "string" && UUID_RE.test(String(v).trim());
}

function normalizeResult(resLike: any) {
  if (!resLike) return { rows: [], rowCount: 0, raw: resLike };
  if (Array.isArray(resLike)) return { rows: resLike, rowCount: resLike.length, raw: resLike };
  const rows = Array.isArray(resLike.rows) ? resLike.rows : [];
  const rowCount = typeof resLike.rowCount === "number" ? resLike.rowCount : rows.length;
  return { rows, rowCount, raw: resLike };
}

function mapPgErrorToResponse(err: any, res: Response, defaultPayload: { code: number; body: any }) {
  // Postgres unique violation
  if (err && err.code === "23505") {
    return res.status(409).json({ error: "department_conflict" });
  }
  // foreign key / other DB errors can be mapped here if desired
  return res.status(defaultPayload.code).json(defaultPayload.body);
}

/* --------------------------- Permissions --------------------------- */

function requireWrite(req: Request, res: Response, next: NextFunction) {
  const ss = (req as any).session;
  if (!ss) return res.status(401).json({ error: "unauthenticated" });

  if (ss.is_tenant_admin || ss.is_admin || ss.is_platform_admin) {
    return next();
  }

  return res.status(403).json({ error: "forbidden" });
}

/* --------------------------- Cycle prevention helpers --------------------------- */

const PARENT_DEPTH_LIMIT = 12;

async function parentBelongsToTenantCompany(parentId: string, tenantId: string, companyId: string) {
  const pr = await q(
    `SELECT 1 FROM hms_departments WHERE id = $1 AND tenant_id = $2 AND company_id = $3 AND deleted_at IS NULL LIMIT 1`,
    [parentId, tenantId, companyId]
  );
  return normalizeResult(pr).rowCount > 0;
}

async function isParentCycle(candidateParentId: string, childId: string, tenantId: string, companyId: string) {
  let current: any = candidateParentId;
  for (let i = 0; i < PARENT_DEPTH_LIMIT; i++) {
    if (!isValidUUID(current)) break;
    if (String(current).trim() === String(childId).trim()) return true;

    const r = await q(
      `SELECT parent_id FROM hms_departments WHERE id = $1 AND tenant_id = $2 AND company_id = $3 LIMIT 1`,
      [current, tenantId, companyId]
    );
    const nr = normalizeResult(r);
    if (nr.rowCount === 0) break;
    const rowParent = nr.rows[0]?.parent_id ?? null;
    if (!rowParent) break;
    current = String(rowParent);
  }
  return false;
}

/* --------------------------- Routes --------------------------- */

/**
 * Utility: parse a query/body param into a boolean
 * Accepts boolean, number 1/0, string "true"/"false"/"1"/"0" (case-insensitive)
 */
function parseBooleanParam(v: unknown): boolean {
  if (v === true) return true;
  if (v === false) return false;
  if (v === 1 || v === "1") return true;
  if (v === 0 || v === "0") return false;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "1") return true;
    return false;
  }
  // `ParsedQs` or other objects are not booleans
  return false;
}

/**
 * GET /api/hms/departments
 * Query params:
 *  - company_id (uuid) optional
 *  - active (true/false/"1"/"0") optional
 *  - include_deleted (true|false) optional
 *  - limit, offset for pagination (default limit=200, offset=0, max limit=2000)
 *
 * Returns: { data: [...], meta: { limit, offset, returned } }
 */
router.get("/", requireSession, async (req: Request, res: Response) => {
  try {
    const ss = (req as any).session;
    if (!ss || !ss.tenant_id) return res.status(401).json({ error: "unauthenticated" });
    const tenantId: string = String(ss.tenant_id);

    const rawCompanyId = Array.isArray(req.query.company_id) ? req.query.company_id[0] : req.query.company_id;
    const rawActive = Array.isArray(req.query.active) ? req.query.active[0] : req.query.active;
    const includeDeletedRaw = Array.isArray(req.query.include_deleted)
      ? req.query.include_deleted[0]
      : req.query.include_deleted;
    const includeDeleted = parseBooleanParam(includeDeletedRaw);

    const params: any[] = [tenantId];
    let where = `d.tenant_id = $1`;

    if (rawCompanyId !== undefined && rawCompanyId !== null && String(rawCompanyId).trim() !== "") {
      const companyId = String(rawCompanyId).trim();
      if (!isValidUUID(companyId)) return res.status(400).json({ error: "invalid_company_id" });
      params.push(companyId);
      where += ` AND d.company_id = $${params.length}`;
    }

    if (rawActive !== undefined && rawActive !== null && String(rawActive).trim() !== "") {
      // Accept boolean, string "true"/"false", "1"/"0"
      const activeBool = parseBooleanParam(rawActive);
      params.push(activeBool);
      where += ` AND d.is_active = $${params.length}`;
    }

    if (!includeDeleted) {
      where += ` AND d.deleted_at IS NULL`;
    }

    // --- pagination: limit & offset with safe defaults ---
    const rawLimit = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
    const rawOffset = Array.isArray(req.query.offset) ? req.query.offset[0] : req.query.offset;

    const parsePositiveInt = (v: any, fallback: number) => {
      if (v === undefined || v === null || String(v).trim() === "") return fallback;
      const n = Number(String(v));
      if (!Number.isFinite(n) || n <= 0) return fallback;
      return Math.floor(n);
    };

    let limit = parsePositiveInt(rawLimit, 200);
    let offset = (() => {
      if (rawOffset === undefined || rawOffset === null || String(rawOffset).trim() === "") return 0;
      const n = Number(String(rawOffset));
      if (!Number.isFinite(n) || n < 0) return 0;
      return Math.floor(n);
    })();

    if (limit > 2000) limit = 2000;

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
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;

    params.push(limit, offset);
    const r = await q(sql, params);
    const nr = normalizeResult(r);
    return res.json({ data: nr.rows ?? [], meta: { limit, offset, returned: nr.rowCount } });
  } catch (err: any) {
    console.error("GET /api/hms/departments error:", err && err.stack ? err.stack : err);
    return res.status(500).json({ error: "departments_fetch_failed" });
  }
});

/**
 * GET /api/hms/departments/:id
 * Query params:
 *  - include_deleted (true|false) optional
 */
router.get("/:id", requireSession, async (req: Request, res: Response) => {
  try {
    const ss = (req as any).session;
    if (!ss || !ss.tenant_id) return res.status(401).json({ error: "unauthenticated" });
    const tenantId: string = String(ss.tenant_id);

    const includeDeletedParam = Array.isArray(req.query.include_deleted) ? req.query.include_deleted[0] : req.query.include_deleted;
    const includeDeleted = parseBooleanParam(includeDeletedParam);

    const id = String(req.params.id || "").trim();
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
      WHERE d.tenant_id = $1 AND d.id = $2 ${!includeDeleted ? "AND d.deleted_at IS NULL" : ""}
      LIMIT 1
    `;
    const r = await q(sql, [tenantId, id]);
    const nr = normalizeResult(r);
    if (nr.rowCount === 0) return res.status(404).json({ error: "not_found" });
    return res.json(nr.rows[0]);
  } catch (err: any) {
    console.error("GET /api/hms/departments/:id error:", err && err.stack ? err.stack : err);
    return res.status(500).json({ error: "department_fetch_failed" });
  }
});

/**
 * POST /api/hms/departments
 */
router.post("/", requireSession, requireWrite, async (req: Request, res: Response) => {
  try {
    const ss = (req as any).session;
    if (!ss || !ss.tenant_id) return res.status(401).json({ error: "unauthenticated" });
    const tenantId: string = String(ss.tenant_id);
    const actor = ss.user_id ?? null;

    const body = req.body || {};
    const {
      name: rawName,
      company_id: rawCompanyId,
      code: rawCode = null,
      description: rawDescription = null,
      parent_id: rawParentId = null,
      is_active: rawIsActive = true,
    } = body;

    // Normalize + trim
    const name = typeof rawName === "string" ? rawName.trim() : rawName;
    const company_id = typeof rawCompanyId === "string" ? rawCompanyId.trim() : rawCompanyId;
    const code = rawCode === null || rawCode === undefined ? null : String(rawCode).trim();
    const description = rawDescription === null || rawDescription === undefined ? null : String(rawDescription).trim();
    const parent_id = rawParentId === null || rawParentId === undefined ? null : String(rawParentId).trim();
    const is_active = rawIsActive === true || rawIsActive === "true" || rawIsActive === 1 || rawIsActive === "1";

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
    }

    // input length validations
    if (typeof name === "string") {
      if (name.length === 0 || name.length > 255) return res.status(400).json({ error: "invalid_name_length" });
    }
    if (code !== null && typeof code === "string" && code.length > 64) return res.status(400).json({ error: "invalid_code_length" });
    if (description !== null && typeof description === "string" && description.length > 2000)
      return res.status(400).json({ error: "invalid_description_length" });

    const insertSql = `
      INSERT INTO hms_departments
        (tenant_id, company_id, name, code, description, parent_id, is_active, created_by, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
      RETURNING id, tenant_id, company_id, name, code, description, parent_id, is_active, created_by, updated_by, created_at, updated_at, deleted_at
    `;

    const r = await q(insertSql, [tenantId, company_id, name, code, description, parent_id, is_active, actor]);
    const nr = normalizeResult(r);
    const created = nr.rows?.[0] ?? null;
    if (!created) return res.status(500).json({ error: "department_create_failed" });
    res.location(`/api/hms/departments/${created.id}`);
    return res.status(201).json(created);
  } catch (err: any) {
    console.error("POST /api/hms/departments error:", err && err.stack ? err.stack : err);
    // Map PG error codes to client-meaningful responses if possible
    if (err && (err as any).code) {
      console.error("PG CODE:", (err as any).code, "DETAIL:", (err as any).detail, "CONSTRAINT:", (err as any).constraint);
      if ((err as any).code === "23505") {
        return res.status(409).json({ error: "department_conflict" });
      }
    }
    return res.status(500).json({ error: "department_create_failed" });
  }
});

/**
 * PUT /api/hms/departments/:id  (full replace)
 */
router.put("/:id", requireSession, requireWrite, async (req: Request, res: Response) => {
  try {
    const ss = (req as any).session;
    if (!ss || !ss.tenant_id) return res.status(401).json({ error: "unauthenticated" });
    const tenantId: string = String(ss.tenant_id);
    const actor = ss.user_id ?? null;

    const id = String(req.params.id || "").trim();
    const {
      name: rawName,
      company_id: rawCompanyId,
      code: rawCode = null,
      description: rawDescription = null,
      parent_id: rawParentId = null,
      is_active: rawIsActive = true,
    } = req.body || {};

    if (!isValidUUID(id)) return res.status(400).json({ error: "invalid_id" });

    // Normalize + trim
    const name = typeof rawName === "string" ? rawName.trim() : rawName;
    const company_id = typeof rawCompanyId === "string" ? rawCompanyId.trim() : rawCompanyId;
    const code = rawCode === null || rawCode === undefined ? null : String(rawCode).trim();
    const description = rawDescription === null || rawDescription === undefined ? null : String(rawDescription).trim();
    const parent_id = rawParentId === null || rawParentId === undefined ? null : String(rawParentId).trim();
    const is_active = rawIsActive === true || rawIsActive === "true" || rawIsActive === 1 || rawIsActive === "1";

    if (!name || typeof name !== "string") return res.status(400).json({ error: "invalid_name" });
    if (!company_id || !isValidUUID(company_id)) return res.status(400).json({ error: "invalid_company_id" });

    const existing = await q(`SELECT company_id FROM hms_departments WHERE tenant_id = $1 AND id = $2 LIMIT 1`, [
      tenantId,
      id,
    ]);
    const ne = normalizeResult(existing);
    if (ne.rowCount === 0) return res.status(404).json({ error: "not_found" });

    const existingCompany = String(ne.rows[0].company_id);
    if (existingCompany !== String(company_id)) {
      return res.status(400).json({ error: "company_change_not_allowed" });
    }

    if (parent_id !== null && parent_id !== undefined) {
      if (!isValidUUID(parent_id)) return res.status(400).json({ error: "invalid_parent_uuid" });
      if (String(parent_id) === id) return res.status(400).json({ error: "invalid_parent_self" });

      const parentOk = await parentBelongsToTenantCompany(parent_id, tenantId, company_id);
      if (!parentOk) return res.status(400).json({ error: "invalid_parent" });

      const cycle = await isParentCycle(parent_id, id, tenantId, company_id);
      if (cycle) return res.status(400).json({ error: "invalid_parent_cycle" });
    }

    // length validations
    if (typeof name === "string") {
      if (name.length === 0 || name.length > 255) return res.status(400).json({ error: "invalid_name_length" });
    }
    if (code !== null && typeof code === "string" && code.length > 64) return res.status(400).json({ error: "invalid_code_length" });
    if (description !== null && typeof description === "string" && description.length > 2000)
      return res.status(400).json({ error: "invalid_description_length" });

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
    const nr = normalizeResult(r);
    if (nr.rowCount === 0) return res.status(404).json({ error: "not_found" });
    return res.json(nr.rows?.[0] ?? null);
  } catch (err: any) {
    console.error("PUT /api/hms/departments/:id error:", err && err.stack ? err.stack : err);
    if (err && (err as any).code) {
      console.error("PG CODE:", (err as any).code, "DETAIL:", (err as any).detail, "CONSTRAINT:", (err as any).constraint);
      if ((err as any).code === "23505") {
        return res.status(409).json({ error: "department_conflict" });
      }
    }
    return res.status(500).json({ error: "department_update_failed" });
  }
});

/**
 * PATCH /api/hms/departments/:id  (partial)
 */
router.patch("/:id", requireSession, requireWrite, async (req: Request, res: Response) => {
  try {
    const ss = (req as any).session;
    if (!ss || !ss.tenant_id) return res.status(401).json({ error: "unauthenticated" });
    const tenantId: string = String(ss.tenant_id);
    const actor = ss.user_id ?? null;

    const id = String(req.params.id || "").trim();
    const patch = req.body || {};

    if (!isValidUUID(id)) return res.status(400).json({ error: "invalid_id" });

    const get = await q(`SELECT * FROM hms_departments WHERE tenant_id = $1 AND id = $2 LIMIT 1`, [tenantId, id]);
    const ng = normalizeResult(get);
    if (ng.rowCount === 0) return res.status(404).json({ error: "not_found" });

    const current = ng.rows[0];

    const name = patch.name !== undefined ? (typeof patch.name === "string" ? patch.name.trim() : patch.name) : current.name;
    const code = patch.code !== undefined ? (patch.code === null ? null : String(patch.code).trim()) : current.code;
    const description = patch.description !== undefined ? (patch.description === null ? null : String(patch.description).trim()) : current.description;
    const parent_id = patch.parent_id !== undefined ? (patch.parent_id === null ? null : String(patch.parent_id).trim()) : current.parent_id;
    const is_active = patch.is_active !== undefined ? (patch.is_active === true || patch.is_active === "true" || patch.is_active === 1 || patch.is_active === "1") : current.is_active;
    const company_id = patch.company_id !== undefined ? (typeof patch.company_id === "string" ? patch.company_id.trim() : patch.company_id) : current.company_id;

    if (!name || typeof name !== "string") return res.status(400).json({ error: "invalid_name" });
    if (!company_id || !isValidUUID(company_id)) return res.status(400).json({ error: "invalid_company_id" });

    if (String(company_id) !== String(current.company_id)) {
      return res.status(400).json({ error: "company_change_not_allowed" });
    }

    if (parent_id !== null && parent_id !== undefined) {
      if (!isValidUUID(parent_id)) return res.status(400).json({ error: "invalid_parent_uuid" });
      if (String(parent_id) === id) return res.status(400).json({ error: "invalid_parent_self" });

      const parentOk = await parentBelongsToTenantCompany(parent_id, tenantId, company_id);
      if (!parentOk) return res.status(400).json({ error: "invalid_parent" });

      const cycle = await isParentCycle(parent_id, id, tenantId, company_id);
      if (cycle) return res.status(400).json({ error: "invalid_parent_cycle" });
    }

    // length validations
    if (typeof name === "string") {
      if (name.length === 0 || name.length > 255) return res.status(400).json({ error: "invalid_name_length" });
    }
    if (code !== null && typeof code === "string" && code.length > 64) return res.status(400).json({ error: "invalid_code_length" });
    if (description !== null && typeof description === "string" && description.length > 2000)
      return res.status(400).json({ error: "invalid_description_length" });

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
    const nr = normalizeResult(r);
    if (nr.rowCount === 0) return res.status(404).json({ error: "not_found" });
    return res.json(nr.rows?.[0] ?? null);
  } catch (err: any) {
    console.error("PATCH /api/hms/departments/:id error:", err && err.stack ? err.stack : err);
    if (err && (err as any).code) {
      console.error("PG CODE:", (err as any).code, "DETAIL:", (err as any).detail, "CONSTRAINT:", (err as any).constraint);
      if ((err as any).code === "23505") {
        return res.status(409).json({ error: "department_conflict" });
      }
    }
    return res.status(500).json({ error: "department_patch_failed" });
  }
});

/**
 * DELETE /api/hms/departments/:id
 */
router.delete("/:id", requireSession, requireWrite, async (req: Request, res: Response) => {
  try {
    const ss = (req as any).session;
    if (!ss || !ss.tenant_id) return res.status(401).json({ error: "unauthenticated" });
    const tenantId: string = String(ss.tenant_id);
    const actor = ss.user_id ?? null;
    const id = String(req.params.id || "").trim();

    if (!isValidUUID(id)) return res.status(400).json({ error: "invalid_id" });

    const r = await q(
      `UPDATE hms_departments
          SET is_active = false, deleted_at = now(), updated_by = $1, updated_at = now()
        WHERE tenant_id = $2 AND id = $3
      RETURNING id`,
      [actor, tenantId, id]
    );
    const nr = normalizeResult(r);
    if (nr.rowCount === 0) return res.status(404).json({ error: "not_found" });
    return res.json({ ok: true });
  } catch (err: any) {
    console.error("DELETE /api/hms/departments/:id error:", err && err.stack ? err.stack : err);
    if (err && (err as any).code) {
      console.error("PG CODE:", (err as any).code, "DETAIL:", (err as any).detail, "CONSTRAINT:", (err as any).constraint);
      if ((err as any).code === "23505") {
        return res.status(409).json({ error: "department_conflict" });
      }
    }
    return res.status(500).json({ error: "department_delete_failed" });
  }
});

export default router;
