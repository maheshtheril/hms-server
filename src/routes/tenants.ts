import { Router } from "express";
import { q } from "../db";
import { requireSession } from "../lib/session-mw";
import { ensurePlatform } from "../lib/rbac";

const router = Router();

/** List tenants */
router.get("/", requireSession, async (req, res) => {
  const me = req.user;
  if (!ensurePlatform(me)) return res.status(403).json({ error: "forbidden" });

  try {
    const { rows } = await q(`
      SELECT id, name, slug, domain, created_at
      FROM tenant
      WHERE deleted_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1000
    `);
    return res.json({ tenants: rows });
  } catch (e) {
    return res.status(500).json({ error: "tenant_list_failed" });
  }
});

/** Get one tenant */
router.get("/:id", requireSession, async (req, res) => {
  const me = req.user;
  if (!ensurePlatform(me)) return res.status(403).json({ error: "forbidden" });

  try {
    const { rows } = await q(
      `SELECT id, name, slug, domain, created_at
       FROM tenant
       WHERE id=$1 AND deleted_at IS NULL
       LIMIT 1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "not_found" });
    return res.json({ tenant: rows[0] });
  } catch {
    return res.status(500).json({ error: "tenant_read_failed" });
  }
});

/** Create tenant */
router.post("/", requireSession, async (req, res) => {
  const me = req.user;
  if (!ensurePlatform(me)) return res.status(403).json({ error: "forbidden" });

  const { name, slug, domain, owner_email } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: "missing_name" });

  await q("BEGIN");
  try {
    const { rows: tRows } = await q(
      `
      INSERT INTO tenant (name, slug, domain)
      VALUES (
        $1,
        COALESCE($2, regexp_replace(lower($1), '[^a-z0-9]+', '-', 'g')),
        $3
      )
      RETURNING id, name, slug, domain, created_at
      `,
      [name.trim(), slug || null, domain || null]
    );
    const tenant = tRows[0];

    // For seeding child rows guarded by RLS:
    await q(`SELECT set_config('app.tenant_id', $1, true)`, [tenant.id]);

    // Seed roles (idempotent)
    await q(
      `
      WITH seeds(key, name) AS (
        VALUES
          ('tenant_owner','Tenant Owner'),
          ('tenant_admin','Tenant Admin'),
          ('tenant_manager','Tenant Manager'),
          ('tenant_billing_admin','Tenant Billing Admin'),
          ('tenant_member','Tenant Member'),
          ('tenant_viewer','Tenant Viewer')
      )
      INSERT INTO role (tenant_id, key, name, permissions)
      SELECT $1::uuid, s.key, s.name, '{}'::text[]
      FROM seeds s
      LEFT JOIN role r ON r.tenant_id=$1::uuid AND lower(r.key)=lower(s.key)
      WHERE r.id IS NULL
      `,
      [tenant.id]
    );

    // Optional owner
    if (owner_email) {
      const { rows: uRows } = await q(
        `SELECT id FROM app_user WHERE lower(email)=lower($1) LIMIT 1`,
        [owner_email]
      );
      const ownerUserId =
        uRows[0]?.id ||
        (await q(
          `INSERT INTO app_user (email, name, is_active)
           VALUES ($1, $1, true) RETURNING id`,
          [owner_email]
        )).rows[0].id;

      const { rows: rRows } = await q(
        `SELECT id FROM role WHERE tenant_id=$1 AND key='tenant_owner'`,
        [tenant.id]
      );
      await q(
        `INSERT INTO user_role (user_id, role_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [ownerUserId, rRows[0].id]
      );
    }

    await q(`SELECT set_config('app.tenant_id', NULL, true)`);
    await q("COMMIT");

    return res.status(201).json({ ok: true, tenant });
  } catch (e: any) {
    await q("ROLLBACK");
    if (String(e?.message || "").includes("duplicate")) {
      return res.status(409).json({ error: "slug_exists" });
    }
    return res.status(500).json({ error: "tenant_create_failed" });
  }
});

/** Update tenant */
router.patch("/:id", requireSession, async (req, res) => {
  const me = req.user;
  if (!ensurePlatform(me)) return res.status(403).json({ error: "forbidden" });

  const { name, slug, domain } = req.body || {};
  if (!name && !slug && !domain) return res.json({ ok: true }); // nothing to do

  try {
    const { rows } = await q(
      `
      UPDATE tenant
         SET name   = COALESCE($2, name),
             slug   = COALESCE($3, slug),
             domain = COALESCE($4, domain)
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING id, name, slug, domain, created_at
      `,
      [req.params.id, name || null, slug || null, domain || null]
    );
    if (!rows[0]) return res.status(404).json({ error: "not_found" });
    return res.json({ ok: true, tenant: rows[0] });
  } catch (e: any) {
    if (String(e?.message || "").includes("duplicate")) {
      return res.status(409).json({ error: "slug_exists" });
    }
    return res.status(500).json({ error: "tenant_update_failed" });
  }
});

/** Delete tenant (soft delete) */
router.delete("/:id", requireSession, async (req, res) => {
  const me = req.user;
  if (!ensurePlatform(me)) return res.status(403).json({ error: "forbidden" });

  try {
    const { rowCount } = await q(
      `UPDATE tenant SET deleted_at = now() WHERE id=$1 AND deleted_at IS NULL`,
      [req.params.id]
    );
    if (!rowCount) return res.status(404).json({ error: "not_found" });
    return res.json({ ok: true });
  } catch {
    return res.status(500).json({ error: "tenant_delete_failed" });
  }
});

export default router;
