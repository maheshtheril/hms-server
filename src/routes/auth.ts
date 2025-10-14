import { Router } from "express";
import { q } from "../db";
import { compare } from "../lib/crypto";
import { issueSession, revokeSession } from "../lib/session";
import { setCookie, clearCookie } from "../lib/cookies";

const router = Router();

/**
 * POST /auth/login
 * Body: { email, password }
 */
router.post("/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "missing_fields" });
  }

  // Fetch active user
  const { rows } = await q(
    "SELECT * FROM app_user WHERE email = $1 AND is_active = true LIMIT 1",
    [email]
  );
  const user = rows[0];
  if (!user) return res.status(401).json({ error: "invalid_credentials" });

  // Verify password
  if (!user.password || !compare(password, user.password)) {
    return res.status(401).json({ error: "invalid_credentials" });
  }

  // Create a session
  const sid = await issueSession(user.id, user.tenant_id || null);
  setCookie(res, process.env.COOKIE_NAME_SID || "sid", sid);

  res.json({ ok: true });
});

/**
 * POST /auth/logout
 */
router.post("/logout", async (req, res) => {
  const sid = req.cookies?.[process.env.COOKIE_NAME_SID || "sid"];
  if (sid) await revokeSession(sid);
  clearCookie(res, process.env.COOKIE_NAME_SID || "sid");
  res.json({ ok: true });
});

/**
 * GET /auth/session
 * Returns current session + user info.
 */
router.get("/session", async (req, res) => {
  const sid = req.cookies?.[process.env.COOKIE_NAME_SID || "sid"];
  if (!sid) return res.json({ user: null });

  const { rows } = await q(
    `SELECT s.sid,
            u.id    AS user_id,
            u.email,
            u.name,
            u.is_admin,
            u.tenant_id,
            u.company_id
       FROM sessions s
       JOIN app_user u ON u.id = s.user_id
      WHERE s.sid = $1`,
    [sid]
  );

  res.json({ user: rows[0] || null });
});
// GET /auth/me — used by the web app after login
router.get("/me", async (req, res) => {
  const cookieName = process.env.COOKIE_NAME_SID || "sid";
  const sid = req.cookies?.[cookieName];
  if (!sid) return res.json({ user: null, roles: [] });

  const { rows } = await q(
    `SELECT s.sid,
            u.id          AS user_id,
            u.email,
            u.name,
            u.is_admin,
            u.tenant_id,
            u.company_id
       FROM sessions s
       JOIN app_user u ON u.id = s.user_id
      WHERE s.sid = $1
      LIMIT 1`,
    [sid]
  );

  const row = rows[0];
  if (!row) return res.json({ user: null, roles: [] });

  const roles = row.is_admin ? ["Admin"] : [];
  res.json({
    user: {
      id: row.user_id,
      email: row.email,
      name: row.name,
      roles,
      role_codes: roles,
      tenant_id: row.tenant_id,
      company_id: row.company_id,
    },
    roles,
  });
});

export default router;
