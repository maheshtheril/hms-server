import type { Request, Response, NextFunction } from "express";
import { q } from "../db";

const COOKIE_NAME = process.env.COOKIE_NAME_SID || "sid";

// augment Express.Request to carry user/roles
declare global {
  namespace Express {
    interface Request {
      sid?: string;
      user?: {
        id: string;
        email: string | null;
        name: string | null;
        is_admin?: boolean;
        is_platform_admin?: boolean;
        is_tenant_admin?: boolean;
        roles?: string[];
        tenant_id?: string | null;
      } | null;
      tenantId?: string | null;
      roles?: string[];
    }
  }
}

/** Read cookie safely even if cookie-parser isn’t present */
function readCookie(req: Request, name: string): string | undefined {
  const direct = (req as any).cookies?.[name];
  if (direct) return direct;
  const raw = req.headers.cookie || "";
  const m = raw.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m?.[1];
}

/** Attach session & user (401 if no valid session) */
export async function requireSession(req: Request, res: Response, next: NextFunction) {
  try {
    const sid =
      readCookie(req, COOKIE_NAME) ||
      readCookie(req, "sid") ||
      readCookie(req, "ssr_sid"); // tolerate alternate cookie names
    if (!sid) return res.status(401).json({ error: "unauthorized" });

    const { rows } = await q(
      `
      SELECT
        s.sid,
        s.tenant_id,
        u.id                              AS user_id,
        u.email,
        u.name,
        COALESCE(u.is_admin, false)       AS is_admin,
        -- collect role keys for this user in this tenant (and global roles)
        COALESCE(
          (
            SELECT array_agg(lower(r.key))
            FROM user_role ur
            JOIN role r ON r.id = ur.role_id
            WHERE ur.user_id = u.id
              AND (r.tenant_id = s.tenant_id OR r.tenant_id IS NULL)
          ),
          '{}'
        ) AS roles
      FROM sessions s
      JOIN app_user u ON u.id = s.user_id
      WHERE s.sid = $1
      LIMIT 1
      `,
      [sid]
    );

    const row = rows[0];
    if (!row) return res.status(401).json({ error: "unauthorized" });

    const roles: string[] = (row.roles || []).map((r: any) => String(r).toLowerCase());
    const isPlatformAdmin = roles.includes("platform_owner")
      || roles.includes("platform_admin")
      || roles.includes("global_super_admin");
    const isTenantAdmin = isPlatformAdmin
      || roles.includes("tenant_owner")
      || roles.includes("tenant_super_admin")
      || roles.includes("tenant_admin");

    req.sid = sid;
    req.roles = roles;
    req.tenantId = row.tenant_id || null;
    req.user = {
      id: row.user_id,
      email: row.email,
      name: row.name,
      is_admin: row.is_admin,
      is_platform_admin: isPlatformAdmin,
      is_tenant_admin: isTenantAdmin,
      roles,
      tenant_id: row.tenant_id || null,
    };

    return next();
  } catch (err) {
    return res.status(500).json({ error: "session_check_failed" });
  }
}
