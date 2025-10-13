"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// server/src/routes/admin/users.ts
const express_1 = require("express");
const db_1 = require("../../db");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const requireSession_1 = __importDefault(require("../../middleware/requireSession"));
const router = (0, express_1.Router)();
// every route needs a valid session → req.session.{tenant_id,user_id, ...}
router.use(requireSession_1.default);
/* ───────── helpers ───────── */
const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUuid = (v) => UUID_RX.test(v);
// Guarded reference to the current tenant UUID in SQL
const TENANT_UUID_SQL = `NULLIF(current_setting('app.tenant_id', true), '')::uuid`;
/** Ensure tenant_id exists & is a UUID (from req.session or x-tenant-id). */
function assertTenant(req) {
    const raw = String(req.session?.tenant_id || req.headers["x-tenant-id"] || "").trim();
    if (!raw)
        throw Object.assign(new Error("tenant_id_required"), { status: 400 });
    if (!isUuid(raw))
        throw Object.assign(new Error("invalid tenant_id"), { status: 400 });
    return raw;
}
/**
 * IMPORTANT: set tenant/user on the SAME client connection you will use.
 * Use non-local set_config (third arg = false) so it persists for this connection.
 */
async function setTenantOn(conn, req) {
    const tid = assertTenant(req);
    await conn.query(`select set_config('app.tenant_id', $1, false)`, [tid]);
    const uid = String(req.session?.user_id || "").trim();
    if (isUuid(uid)) {
        await conn.query(`select set_config('app.user_id', $1, false)`, [uid]);
    }
}
/* ───────── CREATE (user + default company + roles) ───────── */
/** POST /api/admin/users
 * Body: { name, email, password?, roles?: string[], company_id?: uuid }
 * - Validates company belongs to tenant.
 * - If no company_id and tenant has exactly one company → uses it.
 * - Else 400 company_required.
 * - Inserts membership into user_companies with is_default=true and unsets others.
 */
router.post("/", async (req, res, next) => {
    const cx = await db_1.pool.connect();
    try {
        await setTenantOn(cx, req);
        const { name, email, password, roles = [], company_id, } = (req.body || {});
        if (!name || !email)
            return res.status(400).json({ message: "name and email are required" });
        await cx.query("BEGIN");
        // unique per-tenant email
        const dup = await cx.query(`select 1 from public.app_user where tenant_id = ${TENANT_UUID_SQL} and lower(email)=lower($1) limit 1`, [email]);
        if (dup.rowCount) {
            await cx.query("ROLLBACK");
            return res.status(409).json({ message: "Email already exists in this tenant" });
        }
        // resolve final company
        let finalCompanyId = null;
        if (company_id) {
            if (!isUuid(company_id)) {
                await cx.query("ROLLBACK");
                return res.status(400).json({ message: "invalid company_id" });
            }
            const ok = await cx.query(`select 1 from public.company where id = $1 and tenant_id = ${TENANT_UUID_SQL} limit 1`, [company_id]);
            if (!ok.rowCount) {
                await cx.query("ROLLBACK");
                return res.status(400).json({ message: "company_id does not belong to this tenant" });
            }
            finalCompanyId = company_id;
        }
        else {
            const companies = await cx.query(`select id from public.company where tenant_id = ${TENANT_UUID_SQL} order by created_at asc nulls last`);
            if (companies.rowCount === 1) {
                finalCompanyId = companies.rows[0].id;
            }
            else if (companies.rowCount > 1) {
                await cx.query("ROLLBACK");
                return res.status(400).json({ message: "company_required" });
            }
            else {
                await cx.query("ROLLBACK");
                return res.status(400).json({ message: "no_company_in_tenant" });
            }
        }
        const hash = password?.trim() ? await bcryptjs_1.default.hash(password.trim(), 10) : null;
        const ins = await cx.query(`insert into public.app_user (tenant_id, email, name, password, is_active, company_id)
       values (${TENANT_UUID_SQL}, $1, $2, $3, true, $4)
       returning id, email, name, company_id, is_active, created_at`, [email, name, hash, finalCompanyId]);
        const userId = ins.rows[0].id;
        // Assign roles by role.key (tenant-scoped or global)
        if (Array.isArray(roles) && roles.length) {
            const ids = await cx.query(`select id from public.role
          where key = any($1::text[])
            and (tenant_id = ${TENANT_UUID_SQL} or tenant_id is null)`, [roles]);
            if (ids.rowCount !== roles.length) {
                await cx.query("ROLLBACK");
                return res.status(400).json({ message: "One or more roles not found for this tenant" });
            }
            const values = ids.rows.map((_r, i) => `($1,$${i + 2})`).join(",");
            await cx.query(`insert into public.user_role (user_id, role_id) values ${values} on conflict do nothing`, [userId, ...ids.rows.map(r => r.id)]);
        }
        // Ensure user_companies membership + default flag (PLURAL table)
        await cx.query(`insert into public.user_companies (tenant_id, user_id, company_id, is_default)
       values (${TENANT_UUID_SQL}, $1, $2, true)
       on conflict (tenant_id, user_id, company_id) do update
         set is_default = excluded.is_default`, [userId, finalCompanyId]);
        // Unset other defaults for this (tenant, user)
        await cx.query(`update public.user_companies
         set is_default = false
       where tenant_id = ${TENANT_UUID_SQL}
         and user_id   = $1
         and company_id <> $2`, [userId, finalCompanyId]);
        await cx.query("COMMIT");
        res.status(201).json({ ok: true, id: userId });
    }
    catch (e) {
        try {
            await cx.query("ROLLBACK");
        }
        catch { }
        if (e?.status === 400)
            return res.status(400).json({ message: e.message });
        next(e);
    }
    finally {
        cx.release();
    }
});
/* ───────── LIST ───────── */
/** GET /api/admin/users?page=&pageSize=&search=&role=&active=&sort=&dir=
 *  - role: role.key (filters users having that role)
 *  - active: "true" → only active
 *  - sort: name|email|status ; dir: asc|desc
 */
router.get("/", async (req, res, next) => {
    const cx = await db_1.pool.connect();
    try {
        // tenant id from session/header (your existing helper)
        const tenantId = String(req.session?.tenant_id || req.headers["x-tenant-id"] || "").trim();
        if (!tenantId)
            return res.status(401).json({ error: "unauthenticated" });
        // Robust boolean coercion in case flags arrive as strings
        const asBool = (v) => v === true || v === 1 || String(v).toLowerCase?.() === "true" || v === "t";
        const isPlatformAdmin = asBool(req.session?.is_platform_admin);
        // UI params
        const { page = "1", pageSize = "20", search = "", role = "", active = "", sort = "name", dir = "asc", } = req.query;
        const limit = Math.min(100, Math.max(1, parseInt(String(pageSize), 10) || 20));
        const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
        const offset = (pageNum - 1) * limit;
        const SORT_MAP = {
            name: "u.name",
            email: "u.email",
            status: "u.is_active",
        };
        const sortCol = SORT_MAP[String(sort)] || SORT_MAP["name"];
        const sortDir = String(dir).toLowerCase() === "desc" ? "DESC" : "ASC";
        const values = [];
        let vi = 0;
        const where = [];
        // ✅ ALWAYS param-guard tenant unless you deliberately want all-tenants for platform admins.
        // If you never want cross-tenant on this route, keep this guard unconditionally.
        if (!isPlatformAdmin /* || true to force tenant scope for everyone */) {
            where.push(`u.tenant_id = $${++vi}`);
            values.push(tenantId);
        }
        if (String(search).trim()) {
            where.push(`(u.email ILIKE $${++vi} OR COALESCE(u.name,'') ILIKE $${++vi})`);
            values.push(`%${search}%`, `%${search}%`);
        }
        if (String(active).trim() === "true") {
            where.push(`COALESCE(u.is_active, true) = true`);
        }
        if (String(role).trim()) {
            where.push(`EXISTS (
        SELECT 1
        FROM public.user_role ur
        JOIN public.role r ON r.id = ur.role_id
        WHERE ur.user_id = u.id
          AND r.key = $${++vi}
          AND (r.tenant_id = u.tenant_id OR r.tenant_id IS NULL)
      )`);
            values.push(String(role).trim());
        }
        const whereSQL = where.length ? `WHERE ${where.join(" AND ")}` : "";
        // 🔒 If you rely on RLS with app.tenant_id, set it transaction-locally so it sticks under PgBouncer.
        await cx.query("BEGIN");
        await cx.query(`SET LOCAL app.tenant_id = $1`, [tenantId]);
        const countSql = `SELECT COUNT(*)::int AS total FROM public.app_user u ${whereSQL}`;
        const { rows: cntRows } = await cx.query(countSql, values);
        const total = cntRows[0]?.total ?? 0;
        const dataSql = `
      SELECT
        u.id,
        u.tenant_id,
        u.email,
        u.name,
        u.company_id,
        COALESCE(u.is_admin,false)          AS is_admin,
        COALESCE(u.is_platform_admin,false) AS is_platform_admin,
        COALESCE(u.is_tenant_admin,false)   AS is_tenant_admin,
        COALESCE(u.is_active,true)          AS is_active,
        COALESCE(u.is_active,true)          AS active,
        u.created_at,
        COALESCE(ARRAY_REMOVE(ARRAY_AGG(DISTINCT r.key), NULL), '{}')::text[] AS roles
      FROM public.app_user u
      LEFT JOIN public.user_role ur ON ur.user_id = u.id
      LEFT JOIN public.role r
        ON r.id = ur.role_id
       AND (r.tenant_id = u.tenant_id OR r.tenant_id IS NULL)
      ${whereSQL}
      GROUP BY u.id
      ORDER BY ${sortCol} ${sortDir}, u.id ASC
      LIMIT ${limit} OFFSET ${offset}
    `;
        const dataRes = await cx.query(dataSql, values);
        await cx.query("COMMIT");
        // Optional debug headers while you verify
        res.setHeader("X-Debug-Where", whereSQL);
        res.setHeader("X-Debug-Tenant", tenantId);
        res.setHeader("X-Debug-IsPlatform", String(isPlatformAdmin));
        res.json({ items: dataRes.rows, meta: { page: pageNum, pageSize: limit, total } });
    }
    catch (e) {
        try {
            await cx.query("ROLLBACK");
        }
        catch { }
        next(e);
    }
    finally {
        cx.release();
    }
});
/* ───────── READ ───────── */
/** GET /api/admin/users/:id */
router.get("/:id", async (req, res, next) => {
    const cx = await db_1.pool.connect();
    try {
        await setTenantOn(cx, req);
        const { id } = req.params;
        if (!isUuid(id))
            return res.status(400).json({ error: "bad_request", message: "id must be a UUID" });
        const { rows } = await cx.query(`SELECT
         u.id,
         u.tenant_id,
         u.email,
         u.name,
         u.company_id,
         COALESCE(u.is_admin,false)          AS is_admin,
         COALESCE(u.is_platform_admin,false) AS is_platform_admin,
         COALESCE(u.is_tenant_admin,false)   AS is_tenant_admin,
         COALESCE(u.is_active,true)          AS is_active,
         COALESCE(u.is_active,true)          AS active,
         u.created_at,
         COALESCE(ARRAY_REMOVE(ARRAY_AGG(DISTINCT r.key), NULL), '{}')::text[] AS roles
       FROM public.app_user u
       LEFT JOIN public.user_role ur ON ur.user_id = u.id
       LEFT JOIN public.role r
         ON r.id = ur.role_id
        AND (r.tenant_id = u.tenant_id OR r.tenant_id IS NULL)
       WHERE u.id = $1::uuid
         AND (u.tenant_id = ${TENANT_UUID_SQL} OR COALESCE($2::bool,false)) -- platform admin can read cross-tenant
       GROUP BY u.id
       LIMIT 1`, [id, !!req.session?.is_platform_admin]);
        if (!rows.length)
            return res.status(404).json({ error: "not_found" });
        res.json(rows[0]);
    }
    catch (e) {
        next(e);
    }
    finally {
        cx.release();
    }
});
/* ───────── UPDATE ───────── */
/** PATCH /api/admin/users/:id
 * Accepts aliases:
 *  - active → is_active
 */
router.patch("/:id", async (req, res, next) => {
    const cx = await db_1.pool.connect();
    try {
        await setTenantOn(cx, req);
        const { id } = req.params;
        if (!isUuid(id))
            return res.status(400).json({ error: "bad_request", message: "id must be a UUID" });
        const { email, name, is_active, is_admin, is_tenant_admin, is_platform_admin, active, // alias
         } = req.body || {};
        const newActive = typeof is_active === "boolean" ? is_active :
            typeof active === "boolean" ? active :
                null;
        // Optional: restrict platform_admin toggle to platform admins only
        const allowPlatformToggle = !!req.session?.is_platform_admin;
        const { rows } = await cx.query(`UPDATE public.app_user SET
         email             = COALESCE($3, email),
         name              = COALESCE($4, name),
         is_active         = COALESCE($5, is_active),
         is_admin          = COALESCE($6, is_admin),
         is_tenant_admin   = COALESCE($7, is_tenant_admin),
         is_platform_admin = COALESCE(CASE WHEN $9 THEN $8 ELSE NULL END, is_platform_admin)
       WHERE id = $1::uuid
         AND tenant_id = ${TENANT_UUID_SQL}
       RETURNING
         id, tenant_id, email, name, company_id,
         COALESCE(is_admin,false)          AS is_admin,
         COALESCE(is_platform_admin,false) AS is_platform_admin,
         COALESCE(is_tenant_admin,false)   AS is_tenant_admin,
         COALESCE(is_active,true)          AS is_active,
         COALESCE(is_active,true)          AS active,
         created_at`, [
            id,
            null, // placeholder ($2)
            email ?? null,
            name ?? null,
            newActive,
            typeof is_admin === "boolean" ? is_admin : null,
            typeof is_tenant_admin === "boolean" ? is_tenant_admin : null,
            typeof is_platform_admin === "boolean" ? is_platform_admin : null,
            allowPlatformToggle, // $9: only if requester is platform admin
        ]);
        if (!rows.length)
            return res.status(404).json({ error: "not_found" });
        // attach roles[]
        const r = rows[0];
        const rolesRes = await cx.query(`SELECT COALESCE(ARRAY_REMOVE(ARRAY_AGG(DISTINCT r.key), NULL), '{}')::text[] AS roles
       FROM public.user_role ur
       JOIN public.role r ON r.id = ur.role_id
       WHERE ur.user_id = $1`, [id]);
        const roles = rolesRes.rows[0]?.roles ?? [];
        res.json({ ...r, roles });
    }
    catch (e) {
        next(e);
    }
    finally {
        cx.release();
    }
});
/* ───────── RESEND INVITE (stub) ───────── */
router.post("/:id/resend-invite", async (req, res, next) => {
    const cx = await db_1.pool.connect();
    try {
        await setTenantOn(cx, req);
        const { id } = req.params;
        if (!isUuid(id))
            return res.status(400).json({ error: "bad_request", message: "id must be a UUID" });
        // TODO: implement actual email send
        res.json({ ok: true });
    }
    catch (e) {
        next(e);
    }
    finally {
        cx.release();
    }
});
exports.default = router;
