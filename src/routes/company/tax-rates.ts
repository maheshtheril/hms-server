// server/src/routes/company/tax-rates.ts
import express from "express";
import { withTenant } from "../../lib/tx";
import { pool } from "../../db";

const router = express.Router({ mergeParams: true });

function getTenantId(req: any) {
  return (
    (req.headers["x-tenant-id"] as string) ||
    req.cookies?.tenant_id ||
    req.session?.tenantId ||
    null
  );
}

/**
 * POST /api/company/:companyId/tax-rates
 * company override
 */
router.post("/:companyId/tax-rates", async (req, res, next) => {
  const tenantId = getTenantId(req);
  const { companyId } = req.params;

  if (!tenantId) return res.status(401).json({ error: "missing tenant" });
  if (!companyId) return res.status(400).json({ error: "missing companyId" });

  const { name, rate, type, country, state, city, active } = req.body;

  if (!name || typeof rate !== "number") {
    return res.status(400).json({ error: "name + numeric rate required" });
  }

  try {
    const row = await withTenant(tenantId, async (client) => {
      // validate belongs to tenant
      const comp = await client.query(
        `SELECT id, tenant_id FROM public.companies WHERE id=$1 LIMIT 1`,
        [companyId]
      );
      if (comp.rows.length === 0)
        return res.status(404).json({ error: "company not found" });
      if (String(comp.rows[0].tenant_id) !== String(tenantId))
        return res.status(403).json({ error: "company not part of tenant" });

      const sql = `
        INSERT INTO public.tax_rates
          (id, tenant_id, company_id, name, rate, type, country, state, city, active, created_by)
        VALUES
          (gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, coalesce($9,true), $10)
        ON CONFLICT ON CONSTRAINT ux_tax_rates_scope_jurisdiction_name
        DO UPDATE SET
          name = EXCLUDED.name,
          rate = EXCLUDED.rate,
          type = EXCLUDED.type,
          country = EXCLUDED.country,
          state = EXCLUDED.state,
          city = EXCLUDED.city,
          active = EXCLUDED.active,
          updated_at = now(),
          updated_by = COALESCE(EXCLUDED.updated_by, public.tax_rates.updated_by)
        RETURNING *;
      `;
      const params = [
        tenantId,
        companyId,
        name,
        rate,
        type || "surtax",
        country || null,
        state || null,
        city || null,
        active === undefined ? true : !!active,
        req.headers["x-user-id"] || null,
      ];

      const { rows } = await client.query(sql, params);
      return rows[0];
    });

    res.json(row);
  } catch (err: any) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "duplicate tax rule", detail: err.detail });
    }
    next(err);
  }
});

/**
 * GET /api/company/:companyId/effective-tax-rates
 */
router.get("/:companyId/effective-tax-rates", async (req, res, next) => {
  const tenantId = getTenantId(req);
  const { companyId } = req.params;

  if (!tenantId) return res.status(401).json({ error: "missing tenant" });

  const country = (req.query.country as string) || null;
  const state = (req.query.state as string) || null;
  const city = (req.query.city as string) || null;

  try {
    const rows = await withTenant(tenantId, async (client) => {
      // validate
      const comp = await client.query(
        `SELECT id, tenant_id FROM public.companies WHERE id=$1 LIMIT 1`,
        [companyId]
      );
      if (comp.rows.length === 0)
        return res.status(404).json({ error: "company not found" });
      if (String(comp.rows[0].tenant_id) !== String(tenantId))
        return res.status(403).json({ error: "company not part of tenant" });

      const q = `SELECT * FROM public.get_effective_tax_rates($1, $2, $3, $4)`;
      const { rows } = await client.query(q, [
        companyId,
        country,
        state,
        city,
      ]);
      return rows;
    });

    res.json(rows);
  } catch (err) {
    next(err);
  }
});

export default router;
