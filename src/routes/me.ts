// server/src/routes/me.ts
import { Router } from "express";
import { q } from "../db";
import { requireAuth } from "../middleware/requireAuth";

const router = Router();

/**
 * GET /api/me
 * Returns authenticated user info (id, email, name, is_admin, tenant_id, company_id)
 * requireAuth must set req.authSession
 */
router.get("/me", requireAuth, async (req: any, res) => {
  try {
    const authSession = req.authSession;
    if (!authSession?.user_id) return res.status(401).json({ error: "unauthenticated" });

    const { rows } = await q(
      `SELECT id, email, name, is_admin, tenant_id, company_id
         FROM public.app_user
        WHERE id = $1
        LIMIT 1`,
      [authSession.user_id]
    );

    return res.json({ user: rows[0] || null });
  } catch (err) {
    console.error("GET /me error:", err);
    return res.status(500).json({ error: "server_error" });
  }
});

/**
 * GET /api/user/companies
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
      return res.json({ companies: rows });
    }

    // Otherwise, fall back to tenant-based listing
    const tenantId = authSession.tenant_id;
    if (!tenantId) return res.status(400).json({ error: "no_tenant_in_session" });

    // Pagination defaults — adjust as needed
    const LIMIT = 200;

    const { rows } = await q(
      `SELECT id, name, logo_url, tenant_id, enabled
         FROM public.company
        WHERE tenant_id = $1
          AND (enabled IS DISTINCT FROM false)
        ORDER BY name
        LIMIT $2`,
      [tenantId, LIMIT]
    );

    return res.json({ companies: rows });
  } catch (err) {
    console.error("GET /user/companies error:", err);
    return res.status(500).json({ error: "server_error" });
  }
});

export default router;
