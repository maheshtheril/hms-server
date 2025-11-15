// server/src/routes/tenant/tax-rates.ts
import express from "express";
import { withTenant } from "../../lib/tx";
import { pool } from "../../db";

const router = express.Router();

function getTenantId(req: any): string | null {
  return (
    (req.headers["x-tenant-id"] as string) ||
    req.cookies?.tenant_id ||
    req.session?.tenantId ||
    null
  );
}

/**
 * GET /api/tenant/tax-rates
 */
router.get("/", async (req, res, next) => {
  const tenantId = getTenantId(req);
  try {
    const rows = await withTenant(tenantId, async (client) => {
      const sql = `
        SELECT id, tenant_id, company_id, name, rate, type, country, state, city, active,
               created_at, updated_at
        FROM public.tax_rates
        ORDER BY tenant_id NULLS FIRST, company_id NULLS FIRST, name
      `;
      const { rows } = await client.query(sql);
      return rows;
    });

    res.json(rows);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/tenant/tax-rates
 */
router.post("/", async (req, res, next) => {
  const tenantId = getTenantId(req);
  if (!tenantId) return res.status(401).json({ error: "missing tenant" });

  const { name, rate, type, country, state, city, active } = req.body;
  if (!name || typeof rate !== "number") {
    return res.status(400).json({ error: "name + numeric rate required" });
  }

  try {
    const row = await withTenant(tenantId, async (client) => {
      const sql = `
        INSERT INTO public.tax_rates
          (id, tenant_id, name, rate, type, country, state, city, active, created_by)
        VALUES
          (gen_random_uuid(), $1::uuid, $2, $3, $4, $5, $6, $7, coalesce($8,true), $9)
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
        name,
        rate,
        type || "vat",
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

export default router;
