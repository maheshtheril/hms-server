import { Router } from "express";
import requireSession from "../middleware/requireSession";

const router = Router();

/**
 * GET /api/session
 * Returns validated session + active company context.
 * Must be used by frontend to initialize company and user state.
 */
router.get("/", requireSession, async (req, res) => {
  const r = req as any;
  const s = r.session ?? {};
  const c = r.company ?? {};

  res.status(200).json({
    ok: true,
    session: {
      sid: s.sid,
      user_id: s.user_id,
      tenant_id: s.tenant_id,
      active_company_id: c?.active_company_id ?? s?.active_company_id ?? null,
      email: s.email ?? null,
      name: s.name ?? null,
      is_admin: !!s.is_admin,
      is_tenant_admin: !!s.is_tenant_admin,
      is_platform_admin: !!s.is_platform_admin,
    },
  });
});

export default router;
