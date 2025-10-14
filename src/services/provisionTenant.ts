// server/src/services/provisionTenant.ts
import { PoolClient } from "pg";

/**
 * Ensures per-tenant roles exist in public.role and maps the owner user in public.user_role.
 * Uses YOUR schema exactly:
 *   - role(id, tenant_id, key, name, permissions, created_at)
 *   - user_role(id, user_id, role_id, tenant_id, assigned_at)
 *   - role_permission(role_id, permission_code, tenant_id, is_granted, created_at)
 *   - permission(code, name, description, ...)
 */
export async function provisionTenantRBAC(
  cx: PoolClient,
  params: { tenantId: string; ownerUserId: string }
) {
  const { tenantId, ownerUserId } = params;

  // 1) Ensure core roles per tenant (owner, admin, member)
  const rolesToEnsure: Array<{ key: string; name: string }> = [
    { key: "owner", name: "Owner" },
    { key: "admin", name: "Admin" },
    { key: "member", name: "Member" },
  ];

  // Create if missing, return id
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

  // 2) Map OWNER to the new user in user_role (unique on (tenant_id, user_id, role_id))
  await cx.query(
    `
    INSERT INTO public.user_role (user_id, role_id, tenant_id)
    VALUES ($1::uuid, $2::uuid, $3::uuid)
    ON CONFLICT (tenant_id, user_id, role_id) DO NOTHING
    `,
    [ownerUserId, roleIds["owner"], tenantId]
  );

  // 3) (Optional) Attach default permissions to roles if you already have permission codes seeded.
  //    This block is SAFE: it only inserts codes that exist in public.permission.
  //    If you don't want any assumptions, you can remove this whole section.

  // Example minimal defaults: owner gets everything you mark later; leave empty for now.
  // const ownerPerms: string[] = []; // fill with your codes if desired
  // await grantPerms(roleIds["owner"], ownerPerms);

  // Helper to grant permissions safely (idempotent)
  async function grantPerms(roleId: string, permCodes: string[]) {
    if (!permCodes.length) return;
    // Only keep permission codes that exist
    const { rows: valid } = await cx.query<{ code: string }>(
      `SELECT code FROM public.permission WHERE code = ANY($1::text[])`,
      [permCodes]
    );
    const codes = valid.map(v => v.code);
    if (!codes.length) return;

    // Bulk insert ON CONFLICT DO NOTHING
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
}
