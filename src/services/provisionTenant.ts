// server/src/services/provisionTenant.ts
import { Pool } from "pg";
import { randomUUID } from "crypto";

export async function provisionTenantRBAC(pool: Pool, tenantId: string, ownerUserId: string) {
  await pool.query("BEGIN");
  try {
    /* 1) Ensure base roles for this tenant */
    const roles = [
      { name: "Owner", code: "owner" },
      { name: "Admin", code: "admin" },
      { name: "User",  code: "user"  },
    ];

    const roleIds: Record<string, string> = {};
    for (const r of roles) {
      const { rows } = await pool.query(
        `INSERT INTO roles (id, tenant_id, name, code, is_system, created_at)
         VALUES ($1, $2, $3, $4, true, now())
         ON CONFLICT (tenant_id, code) DO UPDATE
           SET name = EXCLUDED.name
         RETURNING id`,
        [randomUUID(), tenantId, r.name, r.code]
      );
      roleIds[r.code] = rows[0].id;
    }

    /* 2) Attach Owner role to ownerUserId */
    await pool.query(
      `INSERT INTO user_roles (tenant_id, user_id, role_id, created_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (tenant_id, user_id, role_id) DO NOTHING`,
      [tenantId, ownerUserId, roleIds.owner]
    );

    /* 3) Copy ALL menu templates into tenant_menus (no module filter!) */
    const { rows: menuRows } = await pool.query(
      `SELECT id AS menu_id, sort_order
         FROM menu_templates
        ORDER BY sort_order NULLS LAST, id`
    );

    for (const m of menuRows) {
      await pool.query(
        `INSERT INTO tenant_menus (tenant_id, menu_id, sort_order, is_enabled, created_at)
         VALUES ($1, $2, $3, true, now())
         ON CONFLICT (tenant_id, menu_id) DO UPDATE
           SET is_enabled = EXCLUDED.is_enabled,
               sort_order = COALESCE(EXCLUDED.sort_order, tenant_menus.sort_order)`,
        [tenantId, m.menu_id, m.sort_order ?? null]
      );
    }

    /* 4) Grant Owner every permission any menu requires */
    const { rows: permCodes } = await pool.query(
      `SELECT DISTINCT permission_code
         FROM menu_templates
        WHERE permission_code IS NOT NULL`
    );

    // Upsert permission records by code (global/shared)
    const codeToPermId: Record<string, string> = {};
    for (const { permission_code } of permCodes) {
      const code = String(permission_code);
      const { rows } = await pool.query(
        `INSERT INTO permissions (id, code, name, created_at)
         VALUES ($1, $2, $2, now())
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [randomUUID(), code]
      );
      codeToPermId[code] = rows[0].id;
    }

    // Attach all permissions to Owner role in this tenant
    for (const code of Object.keys(codeToPermId)) {
      await pool.query(
        `INSERT INTO role_permissions (tenant_id, role_id, permission_id, created_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (tenant_id, role_id, permission_id) DO NOTHING`,
        [tenantId, roleIds.owner, codeToPermId[code]]
      );
    }

    await pool.query("COMMIT");
  } catch (e) {
    await pool.query("ROLLBACK");
    throw e;
  }
}
