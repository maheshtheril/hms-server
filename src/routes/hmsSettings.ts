// server/src/routes/hmsSettings.ts
import { Router, Request, Response, NextFunction } from "express";
import { q } from "../db"; // your DB helper that returns { rows, rowCount } or pg result
import requireSession from "../middleware/requireSession"; // must attach req.session with tenant_id, user_id, flags

const router = Router();

/* --------------------------- small helpers --------------------------- */
function getRowCount(r: any): number {
  if (!r) return 0;
  if (typeof r.rowCount === "number") return r.rowCount;
  if (Array.isArray(r.rows)) return r.rows.length;
  if (Array.isArray(r)) return r.length;
  return 0;
}

function isObject(v: any): v is Record<string, any> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/* --------------------------- permissions --------------------------- */
/**
 * allow write if session has is_tenant_admin || is_admin || is_platform_admin
 * or you can extend to check session.roles / permissions
 */
function requireWrite(req: Request, res: Response, next: NextFunction) {
  const ss = (req as any).session;
  if (!ss) return res.status(401).json({ error: "unauthenticated" });

  if (ss.is_tenant_admin || ss.is_admin || ss.is_platform_admin) return next();

  // optional: check roles array
  // if (Array.isArray(ss.roles) && ss.roles.includes("hms_settings_write")) return next();

  return res.status(403).json({ error: "forbidden" });
}

/* --------------------------- routes --------------------------- */

/**
 * GET /
 * Returns the settings JSON for the current tenant.
 * If none exists returns { settings: {} } (HTTP 200).
 */
router.get("/", requireSession, async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).session.tenant_id;
    const r = await q(`SELECT settings, updated_by, updated_at FROM hms_settings WHERE tenant_id = $1 LIMIT 1`, [
      tenantId,
    ]);

    if (getRowCount(r) === 0) {
      return res.json({ tenantId, settings: {}, meta: { exists: false } });
    }

    const row = r.rows?.[0];
    return res.json({
      tenantId,
      settings: row.settings ?? {},
      updatedBy: row.updated_by ?? null,
      updatedAt: row.updated_at ?? null,
      meta: { exists: true },
    });
  } catch (err) {
    console.error("GET /api/hms/settings error:", err);
    return res.status(500).json({ error: "settings_fetch_failed" });
  }
});

/**
 * PUT /
 * Full replace of settings JSON object for the tenant.
 * Body: JSON object
 */
router.put("/", requireSession, requireWrite, async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).session.tenant_id;
    const actor = (req as any).session.user_id ?? null;
    const incoming = req.body;

    if (!isObject(incoming)) {
      return res.status(400).json({ error: "invalid_payload" });
    }

    const sql = `
      INSERT INTO hms_settings (tenant_id, settings, updated_by, updated_at)
      VALUES ($1, $2::jsonb, $3, now())
      ON CONFLICT (tenant_id)
      DO UPDATE SET settings = $2::jsonb, updated_by = $3, updated_at = now()
      RETURNING tenant_id, settings, updated_by, updated_at
    `;

    const r = await q(sql, [tenantId, JSON.stringify(incoming), actor]);
    return res.status(200).json({ success: true, data: r.rows?.[0] ?? null });
  } catch (err) {
    console.error("PUT /api/hms/settings error:", err);
    return res.status(500).json({ error: "settings_save_failed" });
  }
});

/**
 * PATCH /
 * Partial merge (shallow) of existing settings with provided object.
 * Body: JSON object (fields to merge)
 */
router.patch("/", requireSession, requireWrite, async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).session.tenant_id;
    const actor = (req as any).session.user_id ?? null;
    const patch = req.body;

    if (!isObject(patch)) {
      return res.status(400).json({ error: "invalid_payload" });
    }

    // load existing
    const getR = await q(`SELECT settings FROM hms_settings WHERE tenant_id = $1 LIMIT 1`, [tenantId]);
    const existing = getRowCount(getR) === 0 ? {} : (getR.rows?.[0]?.settings ?? {});

    // shallow merge — replace fields at top-level; use deep merge if needed
    const merged = { ...existing, ...patch };

    const sql = `
      INSERT INTO hms_settings (tenant_id, settings, updated_by, updated_at)
      VALUES ($1, $2::jsonb, $3, now())
      ON CONFLICT (tenant_id)
      DO UPDATE SET settings = $2::jsonb, updated_by = $3, updated_at = now()
      RETURNING tenant_id, settings, updated_by, updated_at
    `;

    const r = await q(sql, [tenantId, JSON.stringify(merged), actor]);
    return res.status(200).json({ success: true, data: r.rows?.[0] ?? null });
  } catch (err) {
    console.error("PATCH /api/hms/settings error:", err);
    return res.status(500).json({ error: "settings_patch_failed" });
  }
});

/**
 * Optional: DELETE /_dev/reset  — dev only (tenant-admin)
 * Removes the tenant's settings. Only include if you want it.
 * Keep it out of production or protect with stricter checks.
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
