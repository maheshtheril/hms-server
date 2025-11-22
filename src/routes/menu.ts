import { Router, Request, Response } from "express";
import { pool } from "../db";
import { buildMenuTree } from "../services/menuService";
import type { PoolClient } from "pg";

const router = Router();

/**
 * GET /api/menu
 * Requirements:
 *  - user must be authenticated (session middleware)
 *  - session must provide: user_id, tenant_id, company_id
 *
 * Response:
 * {
 *   modules: [...],
 *   items: [...menuTree...]
 * }
 */
router.get("/", async (req: Request, res: Response) => {
  const userId = req.session?.user_id;
  const tenantId = req.session?.tenant_id;
  const companyId = req.session?.company_id;

  if (!userId || !tenantId || !companyId) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const cx: PoolClient = await pool.connect();
  try {
    // 1) Load enabled modules for this tenant
    const modules = await cx.query(
      `
      SELECT module_key
      FROM tenant_module
      WHERE tenant_id = $1 AND enabled = true
      `,
      [tenantId]
    );

    const enabledModules = new Set(modules.rows.map((r) => r.module_key));

    // 2) Load user roles
    const rolesQ = await cx.query(
      `
      SELECT r.id, r.key
      FROM user_role ur
      JOIN role r ON r.id = ur.role_id
      WHERE ur.user_id = $1 AND (r.tenant_id IS NULL OR r.tenant_id = $2)
      `,
      [userId, tenantId]
    );

    const roleIds = rolesQ.rows.map((r) => r.id);

    // 3) Load permissions from roles
    let rolePermissions: string[] = [];
    if (roleIds.length > 0) {
      const rp = await cx.query(
        `
        SELECT permission_code
        FROM role_permission
        WHERE role_id = ANY($1::uuid[]) AND (tenant_id IS NULL OR tenant_id = $2)
        `,
        [roleIds, tenantId]
      );
      rolePermissions = rp.rows.map((r) => r.permission_code);
    }

    // 4) Load user-level permissions
    const up = await cx.query(
      `
      SELECT permission_code, is_granted
      FROM user_permission
      WHERE user_id = $1 AND tenant_id = $2
      `,
      [userId, tenantId]
    );

    const userPermissionsGrant = new Set(
      up.rows.filter((r) => r.is_granted).map((r) => r.permission_code)
    );
    const userPermissionsDeny = new Set(
      up.rows.filter((r) => !r.is_granted).map((r) => r.permission_code)
    );

    // merge role+user permissions
    const finalPermissions = new Set<string>();
    rolePermissions.forEach((p) => finalPermissions.add(p));
    userPermissionsGrant.forEach((p) => finalPermissions.add(p));
    userPermissionsDeny.forEach((p) => finalPermissions.delete(p));

    // 5) Load menu items (global)
    const menuItemsQ = await cx.query(
      `
      SELECT *
      FROM menu_items
      WHERE is_active = true
      ORDER BY sort_order ASC
      `
    );

    // 6) Load module->menu map
    const moduleMapQ = await cx.query(
      `
      SELECT module_key, menu_item_id
      FROM module_menu_map
      `
    );

    // apply module gating:
    // only menu items whose module_key is enabled for tenant
    const enabledMenuItems = menuItemsQ.rows.filter((item) =>
      enabledModules.has(item.module_key)
    );

    // 7) Load tenant menu overrides
    const overridesQ = await cx.query(
      `
      SELECT *
      FROM tenant_menu_overrides
      WHERE tenant_id = $1
      `,
      [tenantId]
    );

    // apply overrides into map
    const overrides = overridesQ.rows;

    // 8) Build final menu tree with filters:
    //    - tenant modules
    //    - permission_code exists in finalPermissions OR null
    //    - overrides (hide_modified / label changes)
    const menuTree = buildMenuTree({
      items: enabledMenuItems,
      moduleMap: moduleMapQ.rows,
      permissions: finalPermissions,
      overrides,
    });

    // 9) Return
    return res.json({
      ok: true,
      modules: [...enabledModules],
      items: menuTree,
    });
  } catch (err: any) {
    console.error("[menu] error:", err);
    return res.status(500).json({ ok: false, error: "menu_error" });
  } finally {
    cx.release();
  }
});

export default router;
