// server/src/routes/session.ts
import { Router } from "express";
import requireSession from "../middleware/requireSession";
import cookieParser from "cookie-parser"; // ensure cookie-parser is used at app level

const router = Router();
const COOKIE_NAME = process.env.COOKIE_NAME_SID || "sid";

/**
 * Lightweight probe used by the frontend to quickly check session presence.
 * - Returns 200 + { ok: true, sid } when a sid cookie exists.
 * - Returns 401 when no cookie present (or when you choose to validate and it's invalid).
 *
 * NOTE: This intentionally avoids requireSession so it doesn't redirect/throw;
 * if you want full validation here, replace the cookie check with your session lookup.
 */
router.get("/ping", (req, res) => {
  // req.cookies is available only if cookie-parser middleware is registered on the app.
  const sid = (req.cookies && req.cookies[COOKIE_NAME]) || null;

  if (!sid) {
    return res.status(401).json({ ok: false, error: "no_session" });
  }

  // OPTIONAL: If you want to validate the SID against DB/session store, do it here:
  // const session = await q('SELECT ... FROM sessions WHERE sid = $1', [sid]);
  // if (!session) return res.status(401).json({ ok: false, error: 'invalid_session' });

  return res.status(200).json({ ok: true, sid });
});

/**
 * GET /api/session
 * Returns validated session + active company context.
 * Must be used by frontend to initialize company and user state.
 *
 * This route requires requireSession middleware which must populate req.session and req.company.
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
