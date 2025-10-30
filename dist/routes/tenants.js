"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// server/src/routes/tenant.ts
const express_1 = require("express");
const db_1 = require("../db");
const session_mw_1 = require("../lib/session-mw");
const rbac_1 = require("../lib/rbac");
const router = (0, express_1.Router)();
/**
 * Return current tenant for a logged-in tenant user.
 * Insert this BEFORE the platform-admin list handler so normal users get their tenant,
 * and platform users fall through to the admin list.
 */
router.get("/", session_mw_1.requireSession, async (req, res, next) => {
    try {
        const me = req.user;
        // If platform admin, pass through to admin handler
        if ((0, rbac_1.ensurePlatform)(me))
            return next();
        // Prefer tenant_id on the session user; fall back to me.tenant?.id if available
        const tenantId = me?.tenant_id || (me?.tenant && me.tenant.id) || null;
        if (!tenantId)
            return res.status(404).json({ error: "tenant_not_found" });
        const { rows } = await (0, db_1.q)(`SELECT id, name, slug, domain, created_at
       FROM tenant
       WHERE id = $1 AND deleted_at IS NULL
       LIMIT 1`, [tenantId]);
        if (!rows[0])
            return res.status(404).json({ error: "not_found" });
        return res.json({ tenant: rows[0] });
    }
    catch (err) {
        console.error("GET /api/tenant (current tenant) error:", err);
        return res.status(500).json({ error: "tenant_read_failed" });
    }
});
/** List tenants (platform only) */
router.get("/", session_mw_1.requireSession, async (req, res) => {
    const me = req.user;
    if (!(0, rbac_1.ensurePlatform)(me))
        return res.status(403).json({ error: "forbidden" });
    try {
        const { rows } = await (0, db_1.q)(`
      SELECT id, name, slug, domain, created_at
      FROM tenant
      WHERE deleted_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1000
    `);
        return res.json({ tenants: rows });
    }
    catch (e) {
        console.error("GET /api/tenant list error:", e);
        return res.status(500).json({ error: "tenant_list_failed" });
    }
});
/** Get one tenant (platform only) */
router.get("/:id", session_mw_1.requireSession, async (req, res) => {
    const me = req.user;
    if (!(0, rbac_1.ensurePlatform)(me))
        return res.status(403).json({ error: "forbidden" });
    try {
        const { rows } = await (0, db_1.q)(`SELECT id, name, slug, domain, created_at
       FROM tenant
       WHERE id=$1 AND deleted_at IS NULL
       LIMIT 1`, [req.params.id]);
        if (!rows[0])
            return res.status(404).json({ error: "not_found" });
        return res.json({ tenant: rows[0] });
    }
    catch (e) {
        console.error("GET /api/tenant/:id error:", e);
        return res.status(500).json({ error: "tenant_read_failed" });
    }
});
/** Create tenant (platform only) */
router.post("/", session_mw_1.requireSession, async (req, res) => {
    const me = req.user;
    if (!(0, rbac_1.ensurePlatform)(me))
        return res.status(403).json({ error: "forbidden" });
    const { name, slug, domain, owner_email } = req.body || {};
    if (!name?.trim())
        return res.status(400).json({ error: "missing_name" });
    await (0, db_1.q)("BEGIN");
    try {
        const { rows: tRows } = await (0, db_1.q)(`
      INSERT INTO tenant (name, slug, domain)
      VALUES (
        $1,
        COALESCE($2, regexp_replace(lower($1), '[^a-z0-9]+', '-', 'g')),
        $3
      )
      RETURNING id, name, slug, domain, created_at
      `, [name.trim(), slug || null, domain || null]);
        const tenant = tRows[0];
        // For seeding child rows guarded by RLS:
        await (0, db_1.q)(`SELECT set_config('app.tenant_id', $1, true)`, [tenant.id]);
        // Seed roles (idempotent)
        await (0, db_1.q)(`
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
      `, [tenant.id]);
        // Optional owner
        if (owner_email) {
            const { rows: uRows } = await (0, db_1.q)(`SELECT id FROM app_user WHERE lower(email)=lower($1) LIMIT 1`, [owner_email]);
            const ownerUserId = uRows[0]?.id ||
                (await (0, db_1.q)(`INSERT INTO app_user (email, name, is_active)
           VALUES ($1, $1, true) RETURNING id`, [owner_email])).rows[0].id;
            const { rows: rRows } = await (0, db_1.q)(`SELECT id FROM role WHERE tenant_id=$1 AND key='tenant_owner'`, [tenant.id]);
            await (0, db_1.q)(`INSERT INTO user_role (user_id, role_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`, [ownerUserId, rRows[0].id]);
        }
        await (0, db_1.q)(`SELECT set_config('app.tenant_id', NULL, true)`);
        await (0, db_1.q)("COMMIT");
        return res.status(201).json({ ok: true, tenant });
    }
    catch (e) {
        await (0, db_1.q)("ROLLBACK");
        if (String(e?.message || "").includes("duplicate")) {
            return res.status(409).json({ error: "slug_exists" });
        }
        console.error("POST /api/tenant error:", e);
        return res.status(500).json({ error: "tenant_create_failed" });
    }
});
/** Update tenant (platform only) */
router.patch("/:id", session_mw_1.requireSession, async (req, res) => {
    const me = req.user;
    if (!(0, rbac_1.ensurePlatform)(me))
        return res.status(403).json({ error: "forbidden" });
    const { name, slug, domain } = req.body || {};
    if (!name && !slug && !domain)
        return res.json({ ok: true }); // nothing to do
    try {
        const { rows } = await (0, db_1.q)(`
      UPDATE tenant
         SET name   = COALESCE($2, name),
             slug   = COALESCE($3, slug),
             domain = COALESCE($4, domain)
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING id, name, slug, domain, created_at
      `, [req.params.id, name || null, slug || null, domain || null]);
        if (!rows[0])
            return res.status(404).json({ error: "not_found" });
        return res.json({ ok: true, tenant: rows[0] });
    }
    catch (e) {
        if (String(e?.message || "").includes("duplicate")) {
            return res.status(409).json({ error: "slug_exists" });
        }
        console.error("PATCH /api/tenant/:id error:", e);
        return res.status(500).json({ error: "tenant_update_failed" });
    }
});
/** Delete tenant (soft delete) (platform only) */
router.delete("/:id", session_mw_1.requireSession, async (req, res) => {
    const me = req.user;
    if (!(0, rbac_1.ensurePlatform)(me))
        return res.status(403).json({ error: "forbidden" });
    try {
        const { rowCount } = await (0, db_1.q)(`UPDATE tenant SET deleted_at = now() WHERE id=$1 AND deleted_at IS NULL`, [req.params.id]);
        if (!rowCount)
            return res.status(404).json({ error: "not_found" });
        return res.json({ ok: true });
    }
    catch (e) {
        console.error("DELETE /api/tenant/:id error:", e);
        return res.status(500).json({ error: "tenant_delete_failed" });
    }
});
exports.default = router;
