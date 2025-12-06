// server/src/routes/me.ts
import { Router } from "express";
import { q } from "../db";
import { requireAuth } from "../middleware/requireAuth";

const router = Router();

/**
 * Helper: safe first row
 */
function firstRow(rows: any[]) {
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

/**
 * GET /me
 * Returns authenticated user info + resolved org context:
 * {
 *   user: { id, email, name, is_admin, tenant_id, company_id },
 *   companies: [{ id, name, logo_url, tenant_id, enabled }],
 *   locations: [{ id, name, company_id }]
 * }
 *
 * requireAuth must set req.authSession (with at least user_id; optional tenant_id, company_id)
 *
 * Behavior:
 * - If session has company_id, use it for locations and return that company + locations.
 * - Otherwise:
 *    1) return companies where user is member (user_companies)
 *    2) if none, fall back to companies for session.tenant_id (safe default)
 */
router.get("/me", requireAuth, async (req: any, res) => {
  try {
    const authSession = req.authSession;
    if (!authSession?.user_id) return res.status(401).json({ error: "unauthenticated" });

    // 1) load user
    const { rows: userRows } = await q(
      `SELECT id, email, name, is_admin, tenant_id, company_id, default_location_id
         FROM public.app_user
        WHERE id = $1
        LIMIT 1`,
      [authSession.user_id]
    );

    const user = firstRow(userRows);
    if (!user) return res.status(404).json({ error: "user_not_found" });

    // Prepare containers
    let companies: any[] = [];
    let locations: any[] = [];
    let resolvedCompanyId: string | null = user.company_id || authSession.company_id || null;

    // 2) If authSession already has a company_id prefer that
    if (authSession.company_id) {
      // fetch that single company (safe read)
      const { rows } = await q(
        `SELECT id, name, logo_url, tenant_id, enabled
           FROM public.company
          WHERE id = $1
          LIMIT 1`,
        [authSession.company_id]
      );
      const c = firstRow(rows);
      if (c) companies = [c];
    } else {
      // 3) Try to find companies via user_companies membership
      const { rows: membershipRows } = await q(
        `SELECT c.id, c.name, c.logo_url, c.tenant_id, c.enabled
           FROM public.company c
           JOIN public.user_companies uc ON uc.company_id = c.id
          WHERE uc.user_id = $1
          ORDER BY c.name ASC
          LIMIT 200`,
        [authSession.user_id]
      );
      if (membershipRows && membershipRows.length) {
        companies = membershipRows;
      } else if (user.tenant_id) {
        // 4) Fallback to tenant-scoped companies
        const { rows: tenantRows } = await q(
          `SELECT id, name, logo_url, tenant_id, enabled
             FROM public.company
            WHERE tenant_id = $1
              AND (enabled IS DISTINCT FROM false)
            ORDER BY name
            LIMIT 200`,
          [user.tenant_id]
        );
        companies = tenantRows || [];
      } else {
        companies = [];
      }
    }

    // Decide resolvedCompanyId if not already set:
    if (!resolvedCompanyId) {
      if (user.company_id) resolvedCompanyId = user.company_id;
      else if (companies.length) resolvedCompanyId = companies[0].id;
      else resolvedCompanyId = null;
    }

    // 5) Fetch locations for the resolved company (if any)
    if (resolvedCompanyId) {
      const { rows: locRows } = await q(
        `SELECT id, name, company_id
           FROM public.global_stock_location
          WHERE company_id = $1
          ORDER BY name ASC
          LIMIT 500`,
        [resolvedCompanyId]
      );
      locations = locRows || [];
    } else {
      locations = [];
    }

    // Build response shape
    const resp = {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        is_admin: user.is_admin || false,
        tenant_id: user.tenant_id || null,
        company_id: resolvedCompanyId,
        default_location_id: user.default_location_id || null,
      },
      companies,
      locations,
    };

    return res.json(resp);
  } catch (err) {
    console.error("GET /me error:", err);
    return res.status(500).json({ error: "server_error" });
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
 * NOTE: We do NOT accept user_id from client. Server derives tenant/company from session.
 */
router.get("/user/companies", requireAuth, async (req: any, res) => {
  try {
    const authSession = req.authSession;
    if (!authSession) return res.status(401).json({ error: "unauthenticated" });

    // If session contains an explicit company_id, return only that company
    if (authSession.company_id) {
      const { rows } = await q(
        `SELECT id, name, logo_url, tenant_id, enabled
           FROM public.company
          WHERE id = $1
          LIMIT 1`,
        [authSession.company_id]
      );
      return res.json({ companies: rows || [] });
    }

    // Otherwise, fall back to tenant-based listing
    const tenantId = authSession.tenant_id || null;

    // If tenant not present in session, try to fetch tenant from app_user as a last resort
    let effectiveTenantId = tenantId;
    if (!effectiveTenantId) {
      const { rows: userRows } = await q(`SELECT tenant_id FROM public.app_user WHERE id = $1 LIMIT 1`, [authSession.user_id]);
      if (userRows && userRows.length) effectiveTenantId = userRows[0].tenant_id || null;
    }

    if (!effectiveTenantId) return res.status(400).json({ error: "no_tenant_in_session" });

    // Pagination / safety limit
    const LIMIT = 200;
    const { rows } = await q(
      `SELECT id, name, logo_url, tenant_id, enabled
         FROM public.company
        WHERE tenant_id = $1
          AND (enabled IS DISTINCT FROM false)
        ORDER BY name
        LIMIT $2`,
      [effectiveTenantId, LIMIT]
    );

    return res.json({ companies: rows || [] });
  } catch (err) {
    console.error("GET /user/companies error:", err);
    return res.status(500).json({ error: "server_error" });
  }
});

export default router;
