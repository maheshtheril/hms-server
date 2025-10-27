import { Router, Request, Response, NextFunction } from "express";
import { q } from "../db";
import requireSession from "../middleware/requireSession";

const router = Router();

/* ---------------------------------------------------------------------
   Helper Utilities
------------------------------------------------------------------------ */
function getRowCount(r: any): number {
  if (!r) return 0;
  if (typeof r.rowCount === "number") return r.rowCount;
  if (Array.isArray(r.rows)) return r.rows.length;
  return 0;
}

function isObject(v: any): v is Record<string, any> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/* ---------------------------------------------------------------------
   Permission Checks
------------------------------------------------------------------------ */
function requireWrite(req: Request, res: Response, next: NextFunction) {
  const ss = (req as any).session;
  if (!ss) return res.status(401).json({ error: "unauthenticated" });

  if (ss.is_tenant_admin || ss.is_admin || ss.is_platform_admin) return next();

  // Optional roles array check
  // if (Array.isArray(ss.roles) && ss.roles.includes("hms_settings_write")) return next();

  return res.status(403).json({ error: "forbidden" });
}

/* ---------------------------------------------------------------------
   ROUTES
------------------------------------------------------------------------ */

/**
 * GET /
 * Fetch all HMS settings for the current tenant (optionally filtered by company_id or scope)
 * Query params:
 *    ?company_id=<uuid>
 *    ?scope=tenant|company
 */
router.get("/", requireSession, async (req: Request, res: Response) => {
  try {
    const ss = (req as any).session;
    const tenantId = ss.tenant_id;
    const companyId = req.query.company_id ?? null;
    const scope = req.query.scope ?? "tenant";

    const params: any[] = [tenantId];
    let sql = `SELECT key, value, company_id, scope, updated_by, updated_at
               FROM hms_settings WHERE tenant_id = $1`;

    if (companyId) {
      params.push(companyId);
      sql += ` AND company_id = $${params.length}`;
    }

    if (scope) {
      params.push(scope);
      sql += ` AND scope = $${params.length}`;
    }

    const r = await q(sql, params);
    const settings: Record<string, any> = {};
    r.rows?.forEach((row: any) => {
      settings[row.key] = row.value;
    });

    return res.status(200).json({
      tenantId,
      companyId,
      scope,
      settings,
      meta: { count: getRowCount(r) },
    });
  } catch (err) {
    console.error("GET /api/hms/settings error:", err);
    return res.status(500).json({ error: "settings_fetch_failed" });
  }
});

/**
 * PUT /
 * Full replace (overwrite) of settings for the current tenant & scope.
 * Body: { scope?: "tenant"|"company", company_id?: uuid, settings: { key: value, ... } }
 */
router.put("/", requireSession, requireWrite, async (req: Request, res: Response) => {
  try {
    const ss = (req as any).session;
    const tenantId = ss.tenant_id;
    const actor = ss.user_id ?? null;
    const { scope = "tenant", company_id = null, settings } = req.body;

    if (!isObject(settings)) {
      return res.status(400).json({ error: "invalid_payload" });
    }

    // Delete existing for scope + company
    await q(
      `DELETE FROM hms_settings WHERE tenant_id = $1 AND scope = $2 AND (company_id IS NOT DISTINCT FROM $3)`,
      [tenantId, scope, company_id]
    );

    // Insert all settings
    const inserts = Object.entries(settings).map(([key, value]) =>
      q(
        `INSERT INTO hms_settings (tenant_id, company_id, key, value, scope, updated_by, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, now())`,
        [tenantId, company_id, key, JSON.stringify(value), scope, actor]
      )
    );

    await Promise.all(inserts);

    return res.status(200).json({ success: true, replaced: Object.keys(settings).length });
  } catch (err) {
    console.error("PUT /api/hms/settings error:", err);
    return res.status(500).json({ error: "settings_save_failed" });
  }
});

/**
 * PATCH /
 * Partial merge (upsert) — updates or inserts only provided keys.
 * Body: { scope?: "tenant"|"company", company_id?: uuid, patch: { key: value, ... } }
 */
router.patch("/", requireSession, requireWrite, async (req: Request, res: Response) => {
  try {
    const ss = (req as any).session;
    const tenantId = ss.tenant_id;
    const actor = ss.user_id ?? null;
    const { scope = "tenant", company_id = null, patch } = req.body;

    if (!isObject(patch)) {
      return res.status(400).json({ error: "invalid_payload" });
    }

    const upserts = Object.entries(patch).map(([key, value]) =>
      q(
        `INSERT INTO hms_settings (tenant_id, company_id, key, value, scope, updated_by, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, now())
         ON CONFLICT (tenant_id, company_id, key)
         DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [tenantId, company_id, key, JSON.stringify(value), scope, actor]
      )
    );

    await Promise.all(upserts);
    return res.status(200).json({ success: true, patched: Object.keys(patch).length });
  } catch (err) {
    console.error("PATCH /api/hms/settings error:", err);
    return res.status(500).json({ error: "settings_patch_failed" });
  }
});

/**
 * DELETE /
 * Delete one key or all settings for given scope/company
 * Query: ?key=xyz or ?all=true
 */
router.delete("/", requireSession, requireWrite, async (req: Request, res: Response) => {
  try {
    const ss = (req as any).session;
    const tenantId = ss.tenant_id;
    const companyId = req.query.company_id ?? null;
    const scope = req.query.scope ?? "tenant";
    const key = req.query.key ?? null;
    const all = req.query.all === "true";

    if (!key && !all) {
      return res.status(400).json({ error: "missing_key_or_all" });
    }

    const params: any[] = [tenantId, scope, companyId];
    let sql = `DELETE FROM hms_settings WHERE tenant_id = $1 AND scope = $2 AND (company_id IS NOT DISTINCT FROM $3)`;

    if (!all && key) {
      params.push(key);
      sql += ` AND key = $${params.length}`;
    }

    const r = await q(sql, params);
    return res.status(200).json({ success: true, deleted: r.rowCount ?? 0 });
  } catch (err) {
    console.error("DELETE /api/hms/settings error:", err);
    return res.status(500).json({ error: "settings_delete_failed" });
  }
});

/**
 * POST /_dev/reset
 * Developer endpoint — wipes all settings for tenant (use only in non-prod)
 */
router.post("/_dev/reset", requireSession, requireWrite, async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).session.tenant_id;
    await q(`DELETE FROM hms_settings WHERE tenant_id = $1`, [tenantId]);
    return res.json({ ok: true });
  } catch (err) {
    console.error("POST /api/hms/settings/_dev/reset error:", err);
    return res.status(500).json({ error: "settings_reset_failed" });
  }
});

export default router;
