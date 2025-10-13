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

export default router;
