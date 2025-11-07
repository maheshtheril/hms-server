import { Router, Request, Response } from "express";
import { q } from "../db";
import requireSession from "../middleware/requireSession";
import requireWrite from "../middleware/requireWrite"; // or define like earlier

const router = Router();

/**
 * GET /api/hms/roles
 * Query: company_id, is_clinical, active, search, limit
 */
router.get("/", requireSession, async (req: Request, res: Response) => {
  try {
    const ss: any = (req as any).session;
    if (!ss || !ss.tenant_id) return res.status(401).json({ error: "unauthenticated" });
    const tenantId = String(ss.tenant_id);

    const rawCompany = Array.isArray(req.query.company_id) ? req.query.company_id[0] : req.query.company_id;
    const rawClinical = Array.isArray(req.query.is_clinical) ? req.query.is_clinical[0] : req.query.is_clinical;
    const rawSearch = Array.isArray(req.query.search) ? req.query.search[0] : req.query.search;
    const rawLimit = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;

    const params: any[] = [tenantId];
    let where = "tenant_id = $1";

    if (rawCompany) {
      params.push(String(rawCompany).trim());
      where += ` AND company_id = $${params.length}`;
    }

    if (rawClinical !== undefined) {
      const val = String(rawClinical).trim().toLowerCase();
      if (val === "1" || val === "true") {
        params.push(true);
      } else {
        params.push(false);
      }
      where += ` AND is_clinical = $${params.length}`;
    }

    if (rawSearch && String(rawSearch).trim() !== "") {
      params.push(`%${String(rawSearch).trim().toLowerCase()}%`);
      where += ` AND lower(name) LIKE $${params.length}`;
    }

    const limit = rawLimit ? Math.min(parseInt(String(rawLimit), 10) || 100, 2000) : 200;

    const sql = `SELECT id, tenant_id, company_id, name, code, description, is_clinical, is_active FROM hms_roles WHERE ${where} ORDER BY name LIMIT $${params.length + 1}`;
    params.push(limit);

    const r = await q(sql, params);
    return res.json({ data: r.rows ?? [] });
  } catch (err) {
    console.error("GET /api/hms/roles error:", err);
    return res.status(500).json({ error: "roles_fetch_failed" });
  }
});

// POST create role (admin)
router.post("/", requireSession, requireWrite, async (req: Request, res: Response) => {
  try {
    const ss: any = (req as any).session;
    if (!ss || !ss.tenant_id) return res.status(401).json({ error: "unauthenticated" });
    const tenantId = String(ss.tenant_id);
    const actor = ss.user_id ?? null;

    const { name, company_id = null, code = null, description = null, is_clinical = false, is_active = true } = req.body || {};
    if (!name || String(name).trim() === "") return res.status(400).json({ error: "invalid_name" });

    const insertSql = `
      INSERT INTO hms_roles (tenant_id, company_id, name, code, description, is_clinical, is_active, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,now())
      RETURNING id, tenant_id, company_id, name, code, description, is_clinical, is_active, created_at
    `;
    try {
      const r = await q(insertSql, [tenantId, company_id, String(name).trim(), code, description, is_clinical, is_active]);
      const nr = r.rows?.[0] ?? null;
      return res.status(201).json(nr);
    } catch (err: any) {
      if (err && err.code === "23505") return res.status(409).json({ error: "role_conflict" });
      throw err;
    }
  } catch (err) {
    console.error("POST /api/hms/roles error:", err);
    return res.status(500).json({ error: "role_create_failed" });
  }
});

// PUT/PATCH/DELETE follow same pattern using requireWrite; omitted here for brevity (I can paste them if needed)

export default router;
