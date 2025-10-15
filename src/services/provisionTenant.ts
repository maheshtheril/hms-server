// server/src/services/provisionTenant.ts
import { PoolClient } from "pg";

export async function provisionTenantRBAC(
  cx: PoolClient,
  params: { tenantId: string; ownerUserId: string }
) {
  const { tenantId, ownerUserId } = params;

  // 1) Ensure roles
  const rolesToEnsure: Array<{ key: string; name: string }> = [
    { key: "owner", name: "Owner" },
    { key: "admin", name: "Admin" },
    { key: "member", name: "Member" },
  ];

  async function ensureRole(key: string, name: string): Promise<string> {
    const { rows } = await cx.query<{ id: string }>(
      `
      WITH ins AS (
        INSERT INTO public.role (tenant_id, key, name, permissions)
        SELECT $1::uuid, $2::text, $3::text, '{}'::text[]
        WHERE NOT EXISTS (
          SELECT 1 FROM public.role r WHERE r.tenant_id = $1 AND r.key = $2
        )
        RETURNING id
      )
      SELECT id FROM ins
      UNION ALL
      SELECT r.id FROM public.role r WHERE r.tenant_id = $1 AND r.key = $2
      LIMIT 1
      `,
      [tenantId, key, name]
    );
    if (!rows[0]?.id) throw new Error(`ensureRole failed for key=${key}`);
    return rows[0].id;
  }

  const roleIds: Record<string, string> = {};
  for (const r of rolesToEnsure) {
    roleIds[r.key] = await ensureRole(r.key, r.name);
  }

  // 2) Map OWNER to the user
  await cx.query(
    `
    INSERT INTO public.user_role (user_id, role_id, tenant_id)
    VALUES ($1::uuid, $2::uuid, $3::uuid)
    ON CONFLICT (tenant_id, user_id, role_id) DO NOTHING
    `,
    [ownerUserId, roleIds["owner"], tenantId]
  );

  // Helper to grant permissions safely (idempotent)
  async function grantPerms(roleId: string, permCodes: string[]) {
    if (!permCodes.length) return;

    // keep only valid permission codes present in public.permission
    const { rows: valid } = await cx.query<{ code: string }>(
      `SELECT code FROM public.permission WHERE code = ANY($1::text[])`,
      [permCodes]
    );
    const codes = valid.map(v => v.code);
    if (!codes.length) return;

    await cx.query(
      `
      INSERT INTO public.role_permission (role_id, permission_code, tenant_id, is_granted)
      SELECT $1::uuid, pcode, $2::uuid, TRUE
      FROM unnest($3::text[]) AS t(pcode)
      ON CONFLICT (role_id, permission_code) DO NOTHING
      `,
      [roleId, tenantId, codes]
    );
  }

  // 3) Give OWNER every permission in catalog
  const { rows: allPerms } = await cx.query<{ code: string }>(
    `SELECT code FROM public.permission`
  );
  await grantPerms(roleIds["owner"], allPerms.map(p => p.code));

  // 4) Flip flags so /auth/me is truthy and Sidebar shows Admin
  await cx.query(
    `UPDATE public.app_user
        SET is_admin = TRUE,
            is_tenant_admin = TRUE,
            is_active = TRUE
      WHERE id = $1`,
    [ownerUserId]
  );
}
