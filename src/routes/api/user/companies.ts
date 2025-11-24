// src/routes/api/user/companies.ts
import { Router } from "express";
import { q } from "../../../db";
import { requireAuth } from "../../../middleware/requireAuth";

const router = Router();

router.get("/user/companies", requireAuth, async (req: any, res) => {
  try {
    const authSession = req.authSession;
    if (!authSession?.user_id) return res.status(401).json({ error: "unauthenticated" });

    const tenantId = authSession.tenant_id;
    const userCompanyId = authSession.company_id;

    let rows = [];
    if (tenantId) {
      const r = await q(
        `SELECT id, name, COALESCE(logo_url, '') AS logo_url, tenant_id
         FROM public.company
         WHERE tenant_id = $1
         ORDER BY name
         LIMIT 100`,
        [tenantId]
      );
      rows = r.rows;
    } else if (userCompanyId) {
      const r = await q(
        `SELECT id, name, COALESCE(logo_url, '') AS logo_url, tenant_id
         FROM public.company
         WHERE id = $1
         LIMIT 1`,
        [userCompanyId]
      );
      rows = r.rows;
    }

    return res.json({ companies: rows });
  } catch (err:any) {
    console.error("GET /api/user/companies error:", err);
    return res.status(500).json({ error: "server_error", message: String(err?.message || err) });
  }
});

export default router;
