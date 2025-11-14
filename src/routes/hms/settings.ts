// server/src/routes/hms/settings.ts
import { Router } from "express";
import { z } from "zod";
import { pool } from "../../db"; // adjust path if needed
import type { Request, Response, NextFunction } from "express";

const router = Router();

/**
 * NOTE
 * - Do NOT re-declare Express.Request.user here (that caused the TS error).
 * - Instead, read req.user as any and normalize field names that may differ between middlewares.
 */

/* ---------------------------
   Normalizer: convert various session shapes into a predictable shape
   Accepts common variants: { tenantId } or { tenant_id }, { companyId } or { company_id }.
   Also supports is_admin / is_tenant_admin flags, etc.
   --------------------------- */
function normalizeUserFromReq(req: Request) {
  const u = (req as any).user as any | undefined;
  if (!u) return null;

  const id: string | undefined = u.id ?? u.userId ?? u.user_id;
  const tenantId: string | undefined = u.tenantId ?? u.tenant_id ?? u.orgId ?? u.org_id;
  const companyId: string | undefined = u.companyId ?? u.company_id ?? null;
  const is_admin: boolean = !!(u.is_admin ?? u.isAdmin ?? u.isPlatformAdmin ?? u.is_platform_admin);
  const is_tenant_admin: boolean = !!(u.is_tenant_admin ?? u.isTenantAdmin ?? u.is_tenant_admin);
  // if there are other role fields, you can extend mapping here

  return { id, tenantId, companyId, is_admin, is_tenant_admin, raw: u };
}

/* ---------------------------
   Helper middleware
   --------------------------- */
function requireAuth(req: Request, res: Response, next: NextFunction) {
  const u = normalizeUserFromReq(req);
  if (!u || !u.tenantId || !u.id) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  return next();
}
function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const u = normalizeUserFromReq(req);
  if (!u) return res.status(401).json({ ok: false, error: "unauthorized" });
  if (!u.is_admin && !u.is_tenant_admin) return res.status(403).json({ ok: false, error: "forbidden" });
  return next();
}

/* ---------------------------
   Key-specific validation (server authoritative)
   --------------------------- */
/* billing.currency: { code: string (3), symbol?: string, locale?: string } */
const BillingCurrencySchema = z.object({
  code: z.string().length(3),
  symbol: z.string().min(1).max(8).optional(),
  locale: z.string().min(2).optional(),
});

/* billing.taxes: array of tax lines { id: string, name: string, rate: number, isCompound?: boolean } */
const TaxLineSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  rate: z.number().min(0),
  isCompound: z.boolean().optional(),
});
const BillingTaxesSchema = z.array(TaxLineSchema).min(1);

/* Generic upsert payload */
const UpsertBodySchema = z.object({
  key: z.string().min(1),
  value: z.any(),
  company_id: z.string().uuid().optional().nullable()
});

/* ---------------------------
   GET /
   - Query: ?key=optional
   - Returns merged settings (company overrides tenant)
   --------------------------- */
router.get("/", requireAuth, async (req: Request, res: Response) => {
  try {
    const keyFilter = typeof req.query.key === "string" && req.query.key.trim() ? req.query.key.trim() : null;

    const normalized = normalizeUserFromReq(req)!; // requireAuth ensured presence
    const tenantId = normalized.tenantId!;
    const companyId = normalized.companyId ?? null;

    const params: any[] = [tenantId, companyId];
    const keyClause = keyFilter ? `AND s.key = $3` : "";

    const sql = `
      SELECT s.key, s.value, s.company_id, s.version, s.created_at, s.created_by, s.updated_at, s.updated_by, s.is_active, s.metadata
      FROM public.hms_settings s
      WHERE s.tenant_id = $1
        AND (s.company_id IS NULL OR s.company_id = $2)
        ${keyClause}
      ORDER BY s.company_id DESC NULLS LAST, s.version DESC
    `;

    if (keyFilter) params.push(keyFilter);

    const r = await pool.query(sql, params);
    const map: Record<string, any> = {};
    for (const row of r.rows) {
      if (!(row.key in map)) {
        map[row.key] = row.value;
      }
    }

    if (keyFilter) {
      return res.json({ ok: true, key: keyFilter, value: map[keyFilter] ?? null });
    }
    return res.json({ ok: true, settings: map });
  } catch (err: any) {
    console.error("[hms/settings][GET] error:", err);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

/* ---------------------------
   POST /
   - Body: { key, value, company_id? }
   - Admin only
   - Validates known keys (billing.currency, billing.taxes)
   - Upsert with version bump, set created_by on insert
   --------------------------- */
router.post("/", requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const bodyParsed = UpsertBodySchema.safeParse(req.body);
  if (!bodyParsed.success) {
    return res.status(400).json({ ok: false, error: "invalid_payload", details: bodyParsed.error.flatten() });
  }
  const { key, value: rawValue, company_id } = bodyParsed.data;

  const normalized = normalizeUserFromReq(req)!;
  const tenantId = normalized.tenantId!;
  const companyIdParam = company_id ?? null;
  const updatedBy = normalized.id!;

  // server-side validation for known keys
  let value = rawValue;
  try {
    if (key === "billing.currency") {
      const v = BillingCurrencySchema.parse(rawValue);
      v.code = String(v.code).toUpperCase();
      value = v;
    } else if (key === "billing.taxes") {
      const v = BillingTaxesSchema.parse(rawValue);
      value = v;
    }
  } catch (valErr: any) {
    // zod error: valErr.errors or valErr.issues depending on version — return the message
    const details = (valErr && (valErr.errors || valErr.issues)) ?? String(valErr?.message ?? valErr);
    return res.status(400).json({ ok: false, error: "invalid_value", details });
  }

  try {
    // If company_id provided, ensure it belongs to tenant
    if (companyIdParam) {
      const chk = await pool.query(`SELECT 1 FROM public.company WHERE id = $1 AND tenant_id = $2 LIMIT 1`, [companyIdParam, tenantId]);
      if (chk.rowCount === 0) return res.status(400).json({ ok: false, error: "invalid_company" });
    }

    const upsertSql = `
      INSERT INTO public.hms_settings
        (tenant_id, company_id, key, value, scope, version, updated_by, updated_at, created_by, created_at)
      VALUES
        ($1, $2, $3, $4::jsonb, COALESCE($5,'tenant'), 1, $6, now(), $6, now())
      ON CONFLICT (tenant_id, company_id, key)
      DO UPDATE SET
        value = EXCLUDED.value,
        version = public.hms_settings.version + 1,
        updated_by = EXCLUDED.updated_by,
        updated_at = now()
      RETURNING id, tenant_id, company_id, key, value, scope, version, created_by, created_at, updated_by, updated_at, is_active, metadata;
    `;
    const scope = companyIdParam ? "company" : "tenant";
    const result = await pool.query(upsertSql, [tenantId, companyIdParam, key, JSON.stringify(value), scope, updatedBy]);

    return res.json({ ok: true, row: result.rows[0] });
  } catch (err: any) {
    console.error("[hms/settings][POST] error:", err);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

export default router;
