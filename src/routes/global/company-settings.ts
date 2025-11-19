// server/src/routes/global/company-settings.ts
import express from "express";
import pool from "../../db"; // adjust if your pool lives elsewhere
import { getTenantIdFromReq, requireTenant } from "../../middleware/tenant";
import { body, validationResult } from "express-validator";

const router = express.Router();

/**
 * GET /api/global/company-settings?companyId=...
 * Returns the company_settings row or an object with company_id when not present.
 */
router.get("/", requireTenant, async (req, res) => {
  const tenantId = getTenantIdFromReq(req)!;
  const companyId = String(req.query.companyId || "");
  if (!companyId) return res.status(400).json({ error: "companyId required" });

  try {
    const check = await pool.query(`SELECT id FROM public.company WHERE id = $1 AND tenant_id = $2`, [companyId, tenantId]);
    if (check.rowCount === 0) return res.status(404).json({ error: "company_not_found" });

    const { rows } = await pool.query(`SELECT * FROM public.company_settings WHERE company_id = $1`, [companyId]);
    if (rows.length === 0) return res.json({ company_id: companyId });
    return res.json(rows[0]);
  } catch (err) {
    console.error("GET /api/global/company-settings", err);
    return res.status(500).json({ error: "internal_error" });
  }
});

/**
 * PUT /api/global/company-settings
 * body: { company_id, default_currency_id?, fiscal_year_start?, timezone?, metadata? }
 */
router.put(
  "/",
  requireTenant,
  body("company_id").isUUID(),
  body("default_currency_id").optional().isUUID(),
  body("fiscal_year_start").optional().isISO8601(),
  body("timezone").optional().isString(),
  async (req, res) => {
    const tenantId = getTenantIdFromReq(req)!;
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { company_id, default_currency_id = null, fiscal_year_start = null, timezone = null, metadata = {} } = req.body;

    try {
      const check = await pool.query(`SELECT id FROM public.company WHERE id = $1 AND tenant_id = $2`, [company_id, tenantId]);
      if (check.rowCount === 0) return res.status(404).json({ error: "company_not_found" });

      const upsert = await pool.query(
        `INSERT INTO public.company_settings (company_id, default_currency_id, fiscal_year_start, timezone, metadata, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, now(), now())
         ON CONFLICT (company_id) DO UPDATE
           SET default_currency_id = EXCLUDED.default_currency_id,
               fiscal_year_start = EXCLUDED.fiscal_year_start,
               timezone = EXCLUDED.timezone,
               metadata = EXCLUDED.metadata,
               updated_at = now()
         RETURNING *`,
        [company_id, default_currency_id, fiscal_year_start, timezone, metadata]
      );

      return res.json(upsert.rows[0]);
    } catch (err) {
      console.error("PUT /api/global/company-settings", err);
      return res.status(500).json({ error: "internal_error" });
    }
  }
);

export default router;
