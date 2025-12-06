// server/src/routes/auth.ts
import { Router } from "express";
import { q } from "../db";
import { compare } from "../lib/crypto";
import {
  issueSession,
  revokeSession,
  buildSessionCookie,
  buildClearSessionCookie,
  COOKIE_NAME as SESSION_COOKIE_NAME,
} from "../lib/session";

const router = Router();

/**
 * NOTE: We use the canonical COOKIE_NAME from lib/session to ensure
 * cookie attributes (Domain / SameSite / Secure / Max-Age / HttpOnly)
 * are consistent across signup/login/logout.
 */
const COOKIE_NAME = SESSION_COOKIE_NAME;

/**
 * POST /auth/login
 * Body: { email, password }
 */
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "missing_fields" });
    }

    const emailLc = String(email).trim().toLowerCase();

    // Fetch active user (email normalized)
    const { rows } = await q(
      "SELECT * FROM app_user WHERE lower(email) = $1 AND is_active = true LIMIT 1",
      [emailLc]
    );
    const user = rows[0];
    if (!user) return res.status(401).json({ error: "invalid_credentials" });

    // Verify password
    if (!user.password || !compare(password, user.password)) {
      return res.status(401).json({ error: "invalid_credentials" });
    }

    // Create a session (store tenant_id + company_id if you have it on user)
    const sid = await issueSession(user.id, user.tenant_id || null, user.company_id || null);
    if (!sid) {
      console.error("[login] issueSession returned falsy sid for user:", user.id);
      return res.status(500).json({ error: "session_issue_failed" });
    }

    // Set cookie using shared buildSessionCookie (ensures identical attributes to signup)
    try {
      const setCookieValue = buildSessionCookie(sid);
      // Use Set-Cookie header directly to guarantee the exact string from lib/session
      res.setHeader("Set-Cookie", setCookieValue);

      // helpful debug header (optional)
      if (process.env.NODE_ENV !== "production") {
        res.setHeader("X-Debug-Set-Cookie", `${COOKIE_NAME}=${sid}; debug=true`);
      }
    } catch (cErr) {
      console.error("[login] failed to set Set-Cookie header:", cErr);
      return res.status(500).json({ error: "session_cookie_failed", detail: String(cErr?.message || cErr) });
    }

    // helpful debug header (optional)
    res.setHeader("X-Auth-User", String(user.id));

    // Optional: sanity readback (non-fatal)
    try {
      const sBack = await q(
        "SELECT sid, tenant_id, company_id, user_id, created_at FROM sessions WHERE sid = $1",
        [sid]
      );
      console.info("[login] session readback:", sBack.rows[0]);
    } catch (rbErr) {
      console.error("[login] session readback failed (non-fatal):", rbErr);
    }

    // Return success; frontend should call /auth/me or /auth/session to confirm user
    return res.json({ ok: true });
  } catch (err) {
    console.error("[login] handler error:", err);
    return res.status(500).json({ error: "server_error" });
  }
});

/**
 * POST /auth/logout
 */
router.post("/logout", async (req, res) => {
  const sid = req.cookies?.[COOKIE_NAME];

  try {
    if (sid) {
      // ensure your revokeSession function is called
      await revokeSession(sid);
    }
  } catch (err) {
    console.error("revokeSession error during logout:", err);
    // continue to clear cookie even when revoke fails
  }

  // Clear cookie using canonical builder so attributes match creation
  try {
    const clearValue = buildClearSessionCookie();
    res.setHeader("Set-Cookie", clearValue);
  } catch (cErr) {
    console.error("[logout] failed to set clear cookie header:", cErr);
    // best-effort continue
  }

  // 204 No Content is conventional for logout
  return res.status(204).end();
});

/**
 * GET /auth/session
 * Returns current session + user info.
 */
router.get("/session", async (req, res) => {
  const sid = req.cookies?.[COOKIE_NAME];
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
  const sid = req.cookies?.[COOKIE_NAME];
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
  let tenantId: string | null = row.session_tenant_id || row.user_tenant_id || null;

  if (!tenantId && row.company_id) {
    const t = await q<{ tenant_id: string }>(`SELECT tenant_id FROM company WHERE id = $1 LIMIT 1`, [
      row.company_id,
    ]);
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
    roleKeys = r.rows.map((x) => x.key);
  }

  // 4) (Optional) Aggregate permissions for this tenant
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
    permissions = p.rows.map((x) => x.permission_code);
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
      roles: roleKeys,
      permissions,
      tenant_id: tenantId,
      company_id: row.company_id || null,
    },
    roles: roleKeys,
    tenant: tenantId ? { id: tenantId } : null,
  });
});

// inside server/src/routes/auth.ts (add near other auth handlers)
router.get("/last-login", async (req, res) => {
  try {
    const sid = req.cookies?.[COOKIE_NAME];
    if (!sid) return res.status(404).json({ error: "no_session" });

    const { rows } = await q(
      `SELECT u.id, u.email, s.last_active_at
         FROM sessions s
         JOIN app_user u ON u.id = s.user_id
        WHERE s.sid = $1
        LIMIT 1`,
      [sid]
    );
    if (!rows[0]) return res.status(404).json({ error: "not_found" });

    return res.json({ last_login: rows[0].last_active_at || null });
  } catch (err) {
    console.error("GET /api/auth/last-login error:", err);
    return res.status(500).json({ error: "last_login_failed" });
  }
});

export default router;
