// src/routes/api/user/companies.ts
import { Router } from "express";
import { q } from "../../../db"; // adjust path if your db file is elsewhere
import { requireAuth } from "../../../middleware/requireAuth";

const router = Router();

/**
 * GET /
 * Mounted at /api/user/companies
 */
router.get("/", requireAuth, async (req: any, res) => {
  try {
    const authSession = req.authSession;
    console.debug("GET /api/user/companies - authSession:", authSession);

    if (!authSession?.user_id) {
      console.warn("GET /api/user/companies - unauthenticated");
      return res.status(401).json({ error: "unauthenticated" });
    }

    const tenantId = authSession.tenant_id;
    const userCompanyId = authSession.company_id;

    let rows = [];

    if (tenantId) {
      const qRes = await q(
        `SELECT id, name, COALESCE(logo_url, '') AS logo_url, tenant_id
           FROM public.company
          WHERE tenant_id = $1
          ORDER BY name
          LIMIT 100`,
        [tenantId]
      );
      rows = qRes.rows || [];
    } else if (userCompanyId) {
      const qRes = await q(
        `SELECT id, name, COALESCE(logo_url, '') AS logo_url, tenant_id
           FROM public.company
          WHERE id = $1
          LIMIT 1`,
        [userCompanyId]
      );
      rows = qRes.rows || [];
    }

    return res.json({ companies: rows });
  } catch (err: any) {
    console.error("GET /api/user/companies error:", err && err.message ? err.message : err);
    // In dev we show message; in prod remove err.message
    return res.status(500).json({ error: "server_error", message: String(err?.message || err) });
  }
});

export default router;
