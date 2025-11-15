// server/src/routes/tenant/currencies.ts
import express from "express";
import { withTenant } from "../../lib/tx";
import { pool } from "../../db";

const router = express.Router();

function getTenantId(req: any): string | null {
  return (req.headers["x-tenant-id"] as string) || req.cookies?.tenant_id || req.session?.tenantId || null;
}

/**
 * GET /api/tenant/currencies
 * Returns currencies visible to tenant (global + tenant + company rows belonging to tenant)
 */
router.get("/", async (req, res, next) => {
  const tenantId = getTenantId(req);
  try {
    const rows = await withTenant(tenantId, async (client) => {
      const q = `
        SELECT code, symbol, "precision", locale, active, tenant_id, company_id, created_at, updated_at
        FROM public.currencies
        ORDER BY tenant_id NULLS FIRST, company_id NULLS FIRST, code
      `;
      const { rows } = await client.query(q);
      return rows;
    });
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/tenant/currencies
 * Body: { code, symbol, precision (number), locale, active? }
 * Upserts a tenant-level currency (tenant_id is set from header/session)
 */
router.post("/", async (req, res, next) => {
  const tenantId = getTenantId(req);
  if (!tenantId) return res.status(401).json({ error: "missing tenant" });

  const { code, symbol, precision, locale, active } = req.body || {};
  if (!code || !symbol || typeof precision !== "number") {
    return res.status(400).json({ error: "code, symbol and numeric precision required" });
  }

  try {
    const row = await withTenant(tenantId, async (client) => {
      const sql = `
        INSERT INTO public.currencies (code, symbol, "precision", locale, active, tenant_id, created_by)
        VALUES ($1, $2, $3, $4, coalesce($5, true), $6::uuid, $7)
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
        req.headers["x-user-id"] || null,
      ];
      const { rows } = await client.query(sql, params);
      return rows[0];
    });

    res.json(row);
  } catch (err: any) {
    if (err?.code === "23505") return res.status(409).json({ error: "conflict", detail: err.detail || null });
    next(err);
  }
});

export default router;
