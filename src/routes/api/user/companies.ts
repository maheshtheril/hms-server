// src/routes/api/user/companies.ts
import { Router } from "express";
import { q } from "../../../db"; // adjust to ../../db or ../../../db depending on actual file layout
import { requireAuth } from "../../../middleware/requireAuth";

const router = Router();

/**
 * GET /
 * Returns companies for the current user's tenant, or the user's company if tenant_id missing.
 * Mounted at /api/user/companies (so handler path is "/").
 */
router.get("/", requireAuth, async (req: any, res) => {
  try {
    const authSession = req.authSession;
    if (!authSession?.user_id) {
      console.warn("GET /api/user/companies - unauthenticated request");
      return res.status(401).json({ error: "unauthenticated" });
    }

    const tenantId = authSession.tenant_id;
    const userCompanyId = authSession.company_id;

    let rows = [];
    if (tenantId) {
      const qRes = await q(
        `SELECT id, name, COALESCE(logo_url, '') AS logo_url, tenant_id, enabled, industry
           FROM public.company
          WHERE tenant_id = $1
          ORDER BY name
          LIMIT 100`,
        [tenantId]
      );
      rows = qRes.rows || [];
    } else if (userCompanyId) {
      const qRes = await q(
        `SELECT id, name, COALESCE(logo_url, '') AS logo_url, tenant_id, enabled, industry
           FROM public.company
          WHERE id = $1
          LIMIT 1`,
        [userCompanyId]
      );
      rows = qRes.rows || [];
    }

    return res.json({ companies: rows });
  } catch (err) {
    console.error("GET /api/user/companies error:", err);
    // dev-friendly message — remove or shorten in production
    return res.status(500).json({ error: "server_error", message: String(err?.message || err) });
  }
});

export default router;
