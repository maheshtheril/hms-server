// server/src/routes/me.ts

import { Router } from "express";
import { q } from "../db";
import { requireAuth } from "../middleware/requireAuth";

const router = Router();

/**
 * GET /api/me
 * Return the logged-in user's profile.
 */
router.get("/me", requireAuth, async (req: any, res) => {
  const sid = req.cookies?.[process.env.COOKIE_NAME_SID || "sid"];
  if (!sid) return res.status(401).json({ error: "unauthenticated" });

  // session object was attached by requireAuth
  const s = req.session;
  if (!s?.user_id) return res.status(401).json({ error: "unauthenticated" });

  const { rows } = await q(
    `SELECT id, email, name, is_admin, tenant_id, company_id
       FROM public.app_user
      WHERE id = $1
      LIMIT 1`,
    [s.user_id]
  );

  res.json({ user: rows[0] || null });
});

// ❌ NEW ROUTE ADDED HERE: Fixes GET /api/user/companies 404
/**
 * GET /api/user/companies
 * Returns a list of companies/tenants the current user belongs to.
 * This is crucial for initial data loading/context switching after login/signup.
 */
router.get("/user/companies", requireAuth, async (req: any, res) => {
    const s = req.session;
    if (!s?.user_id) return res.status(401).json({ error: "unauthenticated" });

    // Assuming hms_company stores the tenant/hospital data the user just signed up for
    const { rows } = await q(
        `SELECT c.id, c.name, c.logo_url, c.tenant_id
         FROM public.hms_company c
         JOIN public.app_user u ON u.company_id = c.id
         WHERE u.id = $1
         LIMIT 1`,
        [s.user_id]
    );

    // Frontend expects an array of companies
    res.json({ companies: rows });
});

export default router;