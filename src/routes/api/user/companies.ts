// server/src/routes/api/user/companies.ts
import { Router } from "express";
import { q } from "../../../db";            // matches your other route imports
import { requireAuth } from "../../../middleware/requireAuth";

const router = Router();

/**
 * GET /api/user/companies
 *
 * Returns companies relevant to the authenticated session.
 * - If session has company_id -> returns that single company.
 * - Otherwise returns enabled companies for tenant_id.
 *
 * Optional query params:
 * - limit (number) - max rows to return (default 100)
 * - q (string) - simple name search (ILIKE '%q%')
 */
router.get("/", requireAuth, async (req: any, res) => {
  try {
    const auth = req.authSession;
    if (!auth || !auth.user_id) return res.status(401).json({ error: "unauthenticated" });

    // parse query params
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 100));
    const searchQ = (req.query.q || "").toString().trim();

    // If session contains explicit company_id, return that company only
    if (auth.company_id) {
      const { rows } = await q(
        `SELECT id, name, logo_url, tenant_id, enabled, metadata
           FROM public.company
          WHERE id = $1
          LIMIT 1`,
        [auth.company_id]
      );
      return res.json({ companies: rows });
    }

    // Require tenant_id otherwise we can't scope companies safely
    const tenantId = auth.tenant_id;
    if (!tenantId) return res.status(400).json({ error: "no_tenant_in_session" });

    // Build query — tenant-scoped, only enabled companies by default
    let sql = `
      SELECT id, name, logo_url, tenant_id, enabled, metadata
        FROM public.company
       WHERE tenant_id = $1
         AND (enabled IS DISTINCT FROM false)
    `;
    const params: any[] = [tenantId];

    if (searchQ) {
      params.push(`%${searchQ}%`);
      sql += ` AND name ILIKE $${params.length} `;
    }

    params.push(limit);
    sql += ` ORDER BY name ASC LIMIT $${params.length}`;

    const { rows } = await q(sql, params);
    return res.json({ companies: rows });
  } catch (err) {
    console.error("GET /api/user/companies error:", err);
    return res.status(500).json({ error: "server_error" });
  }
});

export default router;
