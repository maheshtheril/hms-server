// server/src/routes/me.ts
import { Router } from "express";
import { q } from "../db";
import { requireAuth } from "../middleware/requireAuth";

const router = Router();

/**
 * Utility: safe first row
 */
function firstRow(rows: any[] | null | undefined) {
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

/**
 * Utility: normalise the shape returned by your db helper `q`
 * - Some DB helpers return { rows } while others return the raw array.
 */
function normaliseRows(result: any): any[] {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  if (result.rows && Array.isArray(result.rows)) return result.rows;
  // knex/raw sometimes returns [rows, ...] - handle that
  if (Array.isArray(result[0])) return result[0];
  return [];
}

/**
 * GET /me
 * Returns authenticated user info + resolved org context.
 *
 * Response shape:
 * { ok: true, user: {...}, companies: [...], locations: [...] }
 *
 * requireAuth must set req.authSession (with at least user_id; optional tenant_id, company_id)
 */
router.get("/me", requireAuth, async (req: any, res) => {
  try {
    const authSession = req.authSession;
    if (!authSession?.user_id) {
      // Be explicit and consistent for the frontend
      return res.status(401).json({ ok: false, error: "unauthenticated" });
    }

    // If sessionLoader already loaded user-like fields, reuse them where possible.
    // But we still need authoritative user fields like default_location_id so query app_user.
    const USER_QUERY = `
      SELECT id, email, name, is_admin, tenant_id, company_id, default_location_id, is_active
      FROM public.app_user
      WHERE id = $1
      LIMIT 1
    `;

    const userResult = await q(USER_QUERY, [authSession.user_id]);
    const userRows = normaliseRows(userResult);
    const user = firstRow(userRows);

    if (!user) {
      return res.status(404).json({ ok: false, error: "user_not_found" });
    }

    if (user.is_active === false) {
      return res.status(403).json({ ok: false, error: "user_inactive" });
    }

    // Containers
    let companies: any[] = [];
    let locations: any[] = [];
    // Prefer session company -> user.company_id -> unset
    let resolvedCompanyId: string | null = authSession.company_id || user.company_id || null;

    // If session explicitly contains a company_id, fetch that single company
    if (authSession.company_id) {
      const compRes = await q(
        `SELECT id, name, logo_url, tenant_id, enabled FROM public.company WHERE id = $1 LIMIT 1`,
        [authSession.company_id]
      );
      companies = normaliseRows(compRes);
    } else {
      // Try membership via user_companies
      const membershipRes = await q(
        `SELECT c.id, c.name, c.logo_url, c.tenant_id, c.enabled
           FROM public.company c
           JOIN public.user_companies uc ON uc.company_id = c.id
          WHERE uc.user_id = $1
          ORDER BY c.name ASC
          LIMIT 200`,
        [authSession.user_id]
      );
      const membershipRows = normaliseRows(membershipRes);
      if (membershipRows && membershipRows.length) {
        companies = membershipRows;
      } else if (user.tenant_id) {
        // Fallback to tenant-scoped companies
        const tenantRowsRes = await q(
          `SELECT id, name, logo_url, tenant_id, enabled
             FROM public.company
            WHERE tenant_id = $1
              AND (enabled IS DISTINCT FROM false)
            ORDER BY name
            LIMIT 200`,
          [user.tenant_id]
        );
        companies = normaliseRows(tenantRowsRes);
      } else {
        companies = [];
      }
    }

    // Choose resolvedCompanyId if still not set
    if (!resolvedCompanyId) {
      if (user.company_id) resolvedCompanyId = user.company_id;
      else if (companies.length) resolvedCompanyId = companies[0].id;
      else resolvedCompanyId = null;
    }

    // Fetch locations for resolved company if available
    if (resolvedCompanyId) {
      const locRes = await q(
        `SELECT id, name, company_id
           FROM public.global_stock_location
          WHERE company_id = $1
          ORDER BY name ASC
          LIMIT 500`,
        [resolvedCompanyId]
      );
      locations = normaliseRows(locRes);
    } else {
      locations = [];
    }

    // Build response
    const resp = {
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        is_admin: !!user.is_admin,
        tenant_id: user.tenant_id || null,
        company_id: resolvedCompanyId,
        default_location_id: user.default_location_id || null,
      },
      companies,
      locations,
    };

    return res.json(resp);
  } catch (err: any) {
    console.error("GET /me error:", err?.stack || err);

    // Helpful detail in non-prod
    if (process.env.NODE_ENV !== "production") {
      return res.status(500).json({
        ok: false,
        error: "server_error",
        detail: String(err?.message || err),
        stack: err?.stack ? String(err.stack).split("\n") : undefined,
      });
    }

    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

/**
 * GET /user/companies
 * Returns companies relevant to the current session.
 *
 * Behavior:
 * - If session has company_id, return that company (single-item array).
 * - Otherwise list enabled companies for the tenant_id (safe default).
 *
 * NOTE: Server derives tenant/company from session.
 */
router.get("/user/companies", requireAuth, async (req: any, res) => {
  try {
    const authSession = req.authSession;
    if (!authSession?.user_id) return res.status(401).json({ ok: false, error: "unauthenticated" });

    // If session contains an explicit company_id, return only that company
    if (authSession.company_id) {
      const { rows: rowsRaw } = await q(
        `SELECT id, name, logo_url, tenant_id, enabled FROM public.company WHERE id = $1 LIMIT 1`,
        [authSession.company_id]
      );
      const rows = normaliseRows(rowsRaw);
      return res.json({ ok: true, companies: rows });
    }

    // Otherwise, fall back to tenant-based listing
    let effectiveTenantId = authSession.tenant_id || null;

    if (!effectiveTenantId) {
      // last resort: try to read from app_user
      const userTenantRes = await q(`SELECT tenant_id FROM public.app_user WHERE id = $1 LIMIT 1`, [authSession.user_id]);
      const rows = normaliseRows(userTenantRes);
      if (rows && rows.length) effectiveTenantId = rows[0].tenant_id || null;
    }

    if (!effectiveTenantId) return res.status(400).json({ ok: false, error: "no_tenant_in_session" });

    const LIMIT = 200;
    const compsRes = await q(
      `SELECT id, name, logo_url, tenant_id, enabled
         FROM public.company
        WHERE tenant_id = $1
          AND (enabled IS DISTINCT FROM false)
        ORDER BY name
        LIMIT $2`,
      [effectiveTenantId, LIMIT]
    );
    const comps = normaliseRows(compsRes);

    return res.json({ ok: true, companies: comps });
  } catch (err: any) {
    console.error("GET /user/companies error:", err?.stack || err);
    if (process.env.NODE_ENV !== "production") {
      return res.status(500).json({ ok: false, error: "server_error", detail: String(err?.message || err) });
    }
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

export default router;
