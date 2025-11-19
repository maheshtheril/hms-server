// server/src/routes/global/company-taxes.ts
import express from "express";
import pool from "../../db";
import { getTenantIdFromReq, requireTenant } from "../../middleware/tenant";
import { body, param, validationResult } from "express-validator";

const router = express.Router();

/**
 * GET /api/global/company-taxes?companyId=...
 */
router.get("/", requireTenant, async (req, res) => {
  const tenantId = getTenantIdFromReq(req)!;
  const companyId = String(req.query.companyId || "");
  if (!companyId) return res.status(400).json({ error: "companyId required" });

  try {
    const check = await pool.query(`SELECT id FROM public.company WHERE id = $1 AND tenant_id = $2`, [companyId, tenantId]);
    if (check.rowCount === 0) return res.status(404).json({ error: "company_not_found" });

    const { rows } = await pool.query(
      `SELECT id, company_id, name, code, rate, is_active, metadata, created_at, updated_at
       FROM public.company_taxes WHERE company_id = $1 ORDER BY created_at DESC`,
      [companyId]
    );
    return res.json(rows);
  } catch (err) {
    console.error("GET /api/global/company-taxes", err);
    return res.status(500).json({ error: "internal_error" });
  }
});

/**
 * POST /api/global/company-taxes
 */
router.post(
  "/",
  requireTenant,
  body("company_id").isUUID(),
  body("name").isString().notEmpty(),
  body("rate").isNumeric(),
  body("is_active").optional().isBoolean(),
  async (req, res) => {
    const tenantId = getTenantIdFromReq(req)!;
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { company_id, name, code = null, rate, is_active = true, metadata = {} } = req.body;

    try {
      const check = await pool.query(`SELECT id FROM public.company WHERE id = $1 AND tenant_id = $2`, [company_id, tenantId]);
      if (check.rowCount === 0) return res.status(404).json({ error: "company_not_found" });

      const insert = await pool.query(
        `INSERT INTO public.company_taxes (company_id, name, code, rate, is_active, metadata, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6, now(), now()) RETURNING id, company_id, name, code, rate, is_active, metadata, created_at, updated_at`,
        [company_id, name, code, rate, is_active, metadata]
      );

      return res.status(201).json(insert.rows[0]);
    } catch (err) {
      console.error("POST /api/global/company-taxes", err);
      return res.status(500).json({ error: "internal_error" });
    }
  }
);

/**
 * PUT /api/global/company-taxes/:id
 */
router.put(
  "/:id",
  requireTenant,
  param("id").isUUID(),
  body("name").optional().isString(),
  body("rate").optional().isNumeric(),
  body("is_active").optional().isBoolean(),
  async (req, res) => {
    const tenantId = getTenantIdFromReq(req)!;
    const id = String(req.params.id);
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { name, code, rate, is_active, metadata } = req.body;

    try {
      const taxRow = await pool.query(`SELECT company_id FROM public.company_taxes WHERE id = $1`, [id]);
      if (taxRow.rowCount === 0) return res.status(404).json({ error: "tax_not_found" });
      const companyId = taxRow.rows[0].company_id;

      const check = await pool.query(`SELECT id FROM public.company WHERE id = $1 AND tenant_id = $2`, [companyId, tenantId]);
      if (check.rowCount === 0) return res.status(403).json({ error: "forbidden" });

      const updates: string[] = [];
      const params: any[] = [];
      let idx = 1;
      if (name !== undefined) { updates.push(`name = $${idx++}`); params.push(name); }
      if (code !== undefined) { updates.push(`code = $${idx++}`); params.push(code); }
      if (rate !== undefined) { updates.push(`rate = $${idx++}`); params.push(rate); }
      if (is_active !== undefined) { updates.push(`is_active = $${idx++}`); params.push(is_active); }
      if (metadata !== undefined) { updates.push(`metadata = $${idx++}`); params.push(metadata); }

      if (updates.length === 0) return res.status(400).json({ error: "no_fields" });

      params.push(id);
      const q = `UPDATE public.company_taxes SET ${updates.join(", ")}, updated_at = now() WHERE id = $${idx} RETURNING id, company_id, name, code, rate, is_active, metadata, created_at, updated_at`;
      const updated = await pool.query(q, params);
      return res.json(updated.rows[0]);
    } catch (err) {
      console.error("PUT /api/global/company-taxes/:id", err);
      return res.status(500).json({ error: "internal_error" });
    }
  }
);

/**
 * DELETE /api/global/company-taxes/:id
 */
router.delete("/:id", requireTenant, async (req, res) => {
  const tenantId = getTenantIdFromReq(req)!;
  const id = String(req.params.id || "");
  if (!id) return res.status(400).json({ error: "id_required" });

  try {
    const taxRow = await pool.query(`SELECT company_id FROM public.company_taxes WHERE id = $1`, [id]);
    if (taxRow.rowCount === 0) return res.status(404).json({ error: "tax_not_found" });
    const companyId = taxRow.rows[0].company_id;

    const check = await pool.query(`SELECT id FROM public.company WHERE id = $1 AND tenant_id = $2`, [companyId, tenantId]);
    if (check.rowCount === 0) return res.status(403).json({ error: "forbidden" });

    await pool.query(`DELETE FROM public.company_taxes WHERE id = $1`, [id]);
    return res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/global/company-taxes/:id", err);
    return res.status(500).json({ error: "internal_error" });
  }
});

export default router;
