// src/routes/api/user/companies.ts
import { Router } from "express";
import { q } from "../../../db";
import { requireAuth } from "../../../middleware/requireAuth";

const router = Router();

// GET /api/user/companies
router.get("/user/companies", requireAuth, async (req: any, res) => {
  try {
    // Debugging helpers (remove after fix)
    // Log cookies and auth shape so we can confirm the browser sent the sid.
    console.log("GET /api/user/companies - cookies:", req.cookies || req.headers?.cookie || "no cookies");
    console.log("GET /api/user/companies - auth/session shapes:", {
      authSession: req.authSession,
      session: req.session,
      company: req.company,
    });

    // tolerate multiple middleware shapes (requireSession, requireAuth, etc.)
    const authSession = (req as any).authSession || (req as any).session || (req as any).company || null;
    const userId = authSession?.user_id || (req as any).session?.user_id;
    if (!userId) {
      // explicit 401 payload to match client expectation
      return res.status(401).json({ error: "unauthenticated" });
    }

    const tenantId = authSession?.tenant_id || (req as any).session?.tenant_id;
    const userCompanyId =
      authSession?.company_id ||
      (req as any).session?.active_company_id ||
      (req as any).company?.active_company_id ||
      null;

    let rows: Array<any> = [];

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
    } else if (userCompanyId) {
      const r = await q(
        `SELECT id, name, COALESCE(logo_url, '') AS logo_url, tenant_id
         FROM public.company
         WHERE id = $1
         LIMIT 1`,
        [userCompanyId]
      );
      rows = r.rows ?? [];
    }

    // Return companies + active company id for client default selection
    return res.json({
      companies: rows,
      active_company_id: userCompanyId ?? null,
    });
  } catch (err: any) {
    console.error("GET /api/user/companies error:", err);
    return res.status(500).json({
      error: "server_error",
      message: String(err?.message || err),
      stack: process.env.NODE_ENV === "production" ? undefined : String(err?.stack || ""),
    });
  }
});

export default router;
