// server/src/routes/admin/roles.ts
import { Router } from "express";
import { pool } from "../../db";

const router = Router();

// GUC helper (for RLS)
async function setTenant(clientOrPool: any, tenantId?: string | null) {
  await clientOrPool.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId ?? null]);
}
function getTenantId(req: any): string | null {
  return req?.session?.tenant_id ?? (req.headers["x-tenant-id"] as string) ?? null;
}

// Canary
router.get("/__health", (_req, res) => res.json({ ok: true, where: "admin/roles router" }));

// GET /api/admin/roles
router.get("/", async (req, res, next) => {
  try {
    await setTenant(pool, getTenantId(req));
    const { rows } = await pool.query(`
      SELECT
        id,
        key        AS code,
        name,
        NULL::text AS description,
        COALESCE(permissions, '{}')::text[] AS permission_codes
      FROM public.role
      ORDER BY name ASC
    `);
    res.json({ items: rows });
  } catch (e) { next(e); }
});

// POST /api/admin/roles
router.post("/", async (req, res, next) => {
  const { code, name, permission_codes } = req.body || {};
  if (!code || !name) return res.status(400).json({ error: "validation_error", message: "code and name are required" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await setTenant(client, getTenantId(req));
    const ins = await client.query(
      `INSERT INTO public.role (tenant_id, key, name, permissions)
       VALUES (current_setting('app.tenant_id', true), $1, $2, COALESCE($3::text[], '{}'))
       RETURNING id, key AS code, name, COALESCE(permissions, '{}')::text[] AS permission_codes`,
      [String(code).toLowerCase(), name, permission_codes ?? []]
    );
    await client.query("COMMIT");
    res.json(ins.rows[0]);
  } catch (e: any) {
    await client.query("ROLLBACK");
    if (e?.code === "23505") return res.status(409).json({ error: "conflict", message: "Role code already exists in this tenant" });
    next(e);
  } finally {
    client.release();
  }
});

// PATCH /api/admin/roles/:id
router.patch("/:id", async (req, res, next) => {
  const { id } = req.params;
  const { code, name, permission_codes } = req.body || {};
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await setTenant(client, getTenantId(req));
    const upd = await client.query(
      `UPDATE public.role
         SET key = COALESCE($2, key),
             name = COALESCE($3, name),
             permissions = COALESCE($4::text[], permissions)
       WHERE id = $1
       RETURNING id, key AS code, name, COALESCE(permissions, '{}')::text[] AS permission_codes`,
      [id, code ? String(code).toLowerCase() : null, name ?? null, permission_codes ?? null]
    );
    if (!upd.rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "not_found" }); }
    await client.query("COMMIT");
    res.json(upd.rows[0]);
  } catch (e: any) {
    await client.query("ROLLBACK");
    if (e?.code === "23505") return res.status(409).json({ error: "conflict", message: "Role code already exists in this tenant" });
    next(e);
  } finally {
    client.release();
  }
});

// POST /api/admin/roles/:id/permissions
router.post("/:id/permissions", async (req, res, next) => {
  const { id } = req.params;
  const arr = Array.isArray(req.body?.permission_codes) ? req.body.permission_codes : [];
  try {
    await setTenant(pool, getTenantId(req));
    const upd = await pool.query(
      `UPDATE public.role SET permissions = $2::text[] WHERE id = $1
       RETURNING id, key AS code, name, COALESCE(permissions, '{}')::text[] AS permission_codes`,
      [id, arr]
    );
    if (!upd.rows.length) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true, role: upd.rows[0] });
  } catch (e) { next(e); }
});

// DELETE /api/admin/roles/:id
router.delete("/:id", async (req, res, next) => {
  try {
    await setTenant(pool, getTenantId(req));
    const del = await pool.query(`DELETE FROM public.role WHERE id = $1`, [req.params.id]);
    if (!del.rowCount) return res.json({ ok: true }); // idempotent
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
