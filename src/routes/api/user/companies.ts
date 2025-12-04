import { Router } from "express";
import { q } from "../../../db";
import { requireAuth } from "../../../middleware/requireAuth"; // <- named import

const router = Router();

// mounted at /api/user/companies -> path here must be "/"
router.get("/", requireAuth, async (req: any, res) => {
  try {
    const auth = req.authSession;
    if (!auth) return res.status(401).json({ error: "unauthenticated" });

    const tenantId = auth.tenant_id;
    const companyId = auth.company_id;

    let rows: any[] = [];

    if (tenantId) {
      const r = await q(
        `SELECT id, name, COALESCE(logo_url, '') AS logo_url, tenant_id
         FROM public.company
         WHERE tenant_id = $1
         ORDER BY name
         LIMIT 100`,
        [tenantId]
      );
      rows = r.rows ?? [];
    } else if (companyId) {
      const r = await q(
        `SELECT id, name, COALESCE(logo_url, '') AS logo_url, tenant_id
         FROM public.company
         WHERE id = $1
         LIMIT 1`,
        [companyId]
      );
      rows = r.rows ?? [];
    }

    return res.json({ companies: rows });
  } catch (err: any) {
    console.error("GET /api/user/companies error:", err);
    return res.status(500).json({
      error: "server_error",
      message: err?.message || String(err),
      stack: process.env.NODE_ENV === "production" ? undefined : err?.stack,
    });
  }
});

export default router;
