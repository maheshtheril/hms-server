// src/routes/api/user/companies.ts
import { Router } from "express";
import { q } from "../../../db"; // adjust relative path if needed
import { requireAuth } from "../../../middleware/requireAuth";

const router = Router();

/**
 * GET /api/user/companies
 * - Uses req.authSession (set by requireAuth) — expects { user_id, tenant_id, company_id }
 * - Prefers listing companies by tenant_id (multi-tenant). If tenant_id is missing,
 *   falls back to listing the company_id associated with the user.
 */
router.get("/user/companies", requireAuth, async (req: any, res) => {
  try {
    const authSession = req.authSession;
    if (!authSession?.user_id) {
      console.warn("user/companies: unauthenticated request - missing authSession.user_id");
      return res.status(401).json({ error: "unauthenticated" });
    }

    const tenantId = authSession.tenant_id;
    const userCompanyId = authSession.company_id;

    // If tenant present, list companies for that tenant (common pattern).
    // If not, return the single company the user belongs to (if present).
    let rows;
    if (tenantId) {
      const qRes = await q(
        `SELECT id, name, COALESCE(logo_url, '') AS logo_url, tenant_id
           FROM public.company
          WHERE tenant_id = $1
          ORDER BY name
          LIMIT 100`,
        [tenantId]
      );
      rows = qRes.rows;
    } else if (userCompanyId) {
      const qRes = await q(
        `SELECT id, name, COALESCE(logo_url, '') AS logo_url, tenant_id
           FROM public.company
          WHERE id = $1
          LIMIT 1`,
        [userCompanyId]
      );
      rows = qRes.rows;
    } else {
      // nothing to show
      rows = [];
    }

    return res.json({ companies: rows });
  } catch (err) {
    console.error("GET /api/user/companies error:", err);
    // send a small helpful error but avoid leaking stack traces in production
    return res.status(500).json({ error: "server_error", message: String(err?.message || err) });
  }
});

export default router;
