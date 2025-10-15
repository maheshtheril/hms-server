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

  // Create a session (store tenant_id if you have it on user)
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
            s.tenant_id        AS session_tenant_id,
            u.id               AS user_id,
            u.email,
            u.name,
            u.is_admin,
            u.is_tenant_admin,
            u.is_platform_admin,
            u.is_active,
            u.tenant_id        AS user_tenant_id,
            u.company_id
       FROM sessions s
       JOIN app_user u ON u.id = s.user_id
      WHERE s.sid = $1
      LIMIT 1`,
    [sid]
  );

  const row = rows[0];
  if (!row) return res.json({ user: null });

  res.json({
    user: {
      id: row.user_id,
      email: row.email,
      name: row.name,
      is_admin: !!row.is_admin,
      is_tenant_admin: !!row.is_tenant_admin,
      is_platform_admin: !!row.is_platform_admin,
      is_active: !!row.is_active,
      tenant_id: row.session_tenant_id || row.user_tenant_id || null,
      company_id: row.company_id || null,
    },
  });
});

/**
 * GET /auth/me — used by the web app after login
 * Returns flags + tenant-scoped roles (and optionally permissions)
 */
router.get("/me", async (req, res) => {
  const cookieName = process.env.COOKIE_NAME_SID || "sid";
  const sid = req.cookies?.[cookieName];
  if (!sid) return res.json({ user: null, roles: [], tenant: null });

  // 1) Load session + user flags
  const { rows } = await q(
    `SELECT s.sid,
            s.user_id,
            s.tenant_id              AS session_tenant_id,
            u.email,
            u.name,
            u.is_admin,
            u.is_tenant_admin,
            u.is_platform_admin,
            u.is_active,
            u.tenant_id              AS user_tenant_id,
            u.company_id
       FROM sessions s
       JOIN app_user u ON u.id = s.user_id
      WHERE s.sid = $1
      LIMIT 1`,
    [sid]
  );

  const row = rows[0];
  if (!row) return res.json({ user: null, roles: [], tenant: null });

  // 2) Resolve tenant context (priority: session → user.company → user.tenant → default mapping)
  let tenantId: string | null =
    row.session_tenant_id || row.user_tenant_id || null;

  if (!tenantId && row.company_id) {
    const t = await q<{ tenant_id: string }>(
      `SELECT tenant_id FROM company WHERE id = $1 LIMIT 1`,
      [row.company_id]
    );
    tenantId = t.rows[0]?.tenant_id || null;
  }

  if (!tenantId) {
    const t2 = await q<{ tenant_id: string }>(
      `SELECT tenant_id
         FROM user_companies
        WHERE user_id = $1 AND is_default IS TRUE
        LIMIT 1`,
      [row.user_id]
    );
    tenantId = t2.rows[0]?.tenant_id || null;
  }

  // 3) Tenant-scoped roles
  let roleKeys: string[] = [];
  if (tenantId) {
    const r = await q<{ key: string }>(
      `SELECT r.key
         FROM user_role ur
         JOIN role r ON r.id = ur.role_id
        WHERE ur.user_id = $1 AND ur.tenant_id = $2`,
      [row.user_id, tenantId]
    );
    roleKeys = r.rows.map(x => x.key);
  }

  // 4) (Optional) Aggregate permissions for this tenant
  // Safe even if you don't use permissions; it just returns [].
  let permissions: string[] = [];
  if (tenantId) {
    const p = await q<{ permission_code: string }>(
      `SELECT DISTINCT rp.permission_code
         FROM user_role ur
         JOIN role_permission rp ON rp.role_id = ur.role_id
        WHERE ur.user_id = $1
          AND ur.tenant_id = $2
          AND rp.is_granted = TRUE`,
      [row.user_id, tenantId]
    );
    permissions = p.rows.map(x => x.permission_code);
  }

  // 5) Shape for the frontend Sidebar (snake_case flags kept)
  return res.json({
    user: {
      id: row.user_id,
      email: row.email,
      name: row.name,
      is_admin: !!row.is_admin,
      is_tenant_admin: !!row.is_tenant_admin,
      is_platform_admin: !!row.is_platform_admin,
      is_active: !!row.is_active,
      roles: roleKeys,          // e.g. ["owner","admin"]
      permissions,              // optional; leave [] if unused
      tenant_id: tenantId,
      company_id: row.company_id || null,
    },
    roles: roleKeys,            // legacy field you previously returned
    tenant: tenantId ? { id: tenantId } : null,
  });
});

export default router;
