// server/src/routes/company/currencies.ts
import express from "express";
import { withTenant } from "../../lib/tx";
import { pool } from "../../db";

const router = express.Router({ mergeParams: true });

function getTenantId(req: any) {
  return (req.headers["x-tenant-id"] as string) || req.cookies?.tenant_id || req.session?.tenantId || null;
}

/**
 * POST /api/company/:companyId/currencies
 * Body: { code, symbol, precision (number), locale, active? }
 * Upserts a company-level currency. Validates company belongs to tenant.
 */
router.post("/:companyId/currencies", async (req, res, next) => {
  const tenantId = getTenantId(req);
  const { companyId } = req.params;
  if (!tenantId) return res.status(401).json({ error: "missing tenant" });
  if (!companyId) return res.status(400).json({ error: "missing companyId" });

  const { code, symbol, precision, locale, active } = req.body || {};
  if (!code || !symbol || typeof precision !== "number") {
    return res.status(400).json({ error: "code, symbol and numeric precision required" });
  }

  try {
    const row = await withTenant(tenantId, async (client) => {
      // validate company belongs to tenant
      const { rows: compRows } = await client.query(`SELECT id, tenant_id FROM public.companies WHERE id=$1 LIMIT 1`, [companyId]);
      if (compRows.length === 0) throw Object.assign(new Error("company not found"), { status: 404 });
      if (String(compRows[0].tenant_id) !== String(tenantId)) throw Object.assign(new Error("company not part of tenant"), { status: 403 });

      const sql = `
        INSERT INTO public.currencies (code, symbol, "precision", locale, active, tenant_id, company_id, created_by)
        VALUES ($1, $2, $3, $4, coalesce($5, true), $6::uuid, $7::uuid, $8)
        ON CONFLICT ON CONSTRAINT ux_currencies_scope_code
        DO UPDATE SET
          symbol = EXCLUDED.symbol,
          "precision" = EXCLUDED."precision",
          locale = EXCLUDED.locale,
          active = EXCLUDED.active,
          updated_at = now(),
          updated_by = COALESCE(EXCLUDED.updated_by, public.currencies.updated_by)
        RETURNING code, symbol, "precision", locale, active, tenant_id, company_id, created_at, updated_at;
      `;
      const params = [
        code.toUpperCase(),
        symbol,
        precision,
        locale || null,
        active === undefined ? true : !!active,
        tenantId,
        companyId,
        req.headers["x-user-id"] || null,
      ];
      const { rows } = await client.query(sql, params);
      return rows[0];
    });

    res.json(row);
  } catch (err: any) {
    if (err?.status) return res.status(err.status).json({ error: err.message });
    if (err?.code === "23505") return res.status(409).json({ error: "conflict", detail: err.detail || null });
    next(err);
  }
});

/**
 * GET /api/company/:companyId/effective-currency?code=USD
 * Uses DB function public.get_effective_currency(code, companyId)
 */
router.get("/:companyId/effective-currency", async (req, res, next) => {
  const tenantId = getTenantId(req);
  const { companyId } = req.params;
  const code = (req.query.code as string) || null;
  if (!tenantId) return res.status(401).json({ error: "missing tenant" });
  if (!companyId) return res.status(400).json({ error: "missing companyId" });
  if (!code) return res.status(400).json({ error: "missing code query param" });

  try {
    const rows = await withTenant(tenantId, async (client) => {
      // validate company belongs to tenant
      const { rows: compRows } = await client.query(`SELECT id, tenant_id FROM public.companies WHERE id=$1 LIMIT 1`, [companyId]);
      if (compRows.length === 0) throw Object.assign(new Error("company not found"), { status: 404 });
      if (String(compRows[0].tenant_id) !== String(tenantId)) throw Object.assign(new Error("company not part of tenant"), { status: 403 });

      const q = `SELECT * FROM public.get_effective_currency($1::text, $2::uuid)`;
      const { rows } = await client.query(q, [code.toUpperCase(), companyId]);
      return rows;
    });

    res.json(rows[0] ?? null);
  } catch (err: any) {
    if (err?.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

export default router;
