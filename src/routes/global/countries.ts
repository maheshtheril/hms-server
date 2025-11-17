// server/src/routes/global/countries.ts
import express from "express";
import { query } from "../../db";

const router = express.Router();

/**
 * GET /api/global/countries
 * Optional: ?active=true|false  ?q=search
 */
router.get("/", async (req, res, next) => {
  try {
    const { active, q } = req.query;
    const cond: string[] = [];
    const vals: any[] = [];
    let i = 1;

    if (active === "true" || active === "false") {
      cond.push(`is_active = $${i++}`);
      vals.push(active === "true");
    }

    if (typeof q === "string" && q.trim()) {
      const t = `%${q.trim().toLowerCase()}%`;
      cond.push(`(LOWER(name) LIKE $${i} OR LOWER(iso2) LIKE $${i} OR LOWER(iso3) LIKE $${i})`);
      vals.push(t);
      i++;
    }

    const where = cond.length ? `WHERE ${cond.join(" AND ")}` : "";
    const sql = `
      SELECT id, iso2, iso3, name, flag, region, subregion, is_active, created_at, updated_at
      FROM public.countries
      ${where}
      ORDER BY name ASC
      LIMIT 1000
    `;
    const { rows } = await query(sql, vals);
    res.json({ ok: true, data: rows });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/global/countries/:id
 */
router.get("/:id", async (req, res, next) => {
  try {
    const sql = `SELECT id, iso2, iso3, name, flag, region, subregion, is_active, created_at, updated_at FROM public.countries WHERE id = $1 LIMIT 1`;
    const { rows } = await query(sql, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ ok: false, error: "not_found" });
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/global/countries/:id/tax-defaults
 * Returns the country_tax_mappings for the country joined with tax_rates and tax_types
 */
router.get("/:id/tax-defaults", async (req, res, next) => {
  try {
    const countryId = req.params.id;
    const sql = `
      SELECT ctm.id AS mapping_id,
             ctm.country_id,
             ctm.tax_type_id,
             tt.name AS tax_type_name,
             ctm.tax_rate_id,
             tr.name AS tax_rate_name,
             tr.rate AS tax_rate_value,
             ctm.is_active AS mapping_active
      FROM public.country_tax_mappings ctm
      LEFT JOIN public.tax_types tt ON tt.id = ctm.tax_type_id
      LEFT JOIN public.tax_rates tr ON tr.id = ctm.tax_rate_id
      WHERE ctm.country_id = $1
      ORDER BY tt.name NULLS LAST
    `;
    const { rows } = await query(sql, [countryId]);
    res.json({ ok: true, data: rows });
  } catch (err) {
    next(err);
  }
});

export default router;
