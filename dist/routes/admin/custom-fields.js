"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
// server/src/routes/admin/custom-fields.ts
const express_1 = require("express");
const db_1 = require("../../db");
const cookie = __importStar(require("cookie"));
const router = (0, express_1.Router)();
/* ── Helpers ────────────────────────────────────────────────────────── */
function isUuid(v) {
    return /^[0-9a-fA-F-]{36}$/.test(v);
}
async function hydrateSession(req) {
    if (req.session)
        return;
    const cookiesObj = cookie.parse(req.headers.cookie || "");
    const sid = cookiesObj.sid || cookiesObj.ssr_sid;
    if (!sid)
        return;
    const r = await db_1.pool.query(`
    select sid, user_id, tenant_id
      from session
     where sid = $1
       and (expires_at is null or expires_at > now())
     limit 1
    `, [sid]);
    const sess = r.rows[0];
    if (sess) {
        req.session = {
            sid: sess.sid,
            user_id: sess.user_id,
            tenant_id: sess.tenant_id,
            company_id: null,
        };
        db_1.pool.query(`update session set last_seen_at = now() where sid = $1`, [sid]).catch(() => { });
    }
}
async function setTenant(req) {
    const tenantId = req.session?.tenant_id || req.headers["x-tenant-id"] || null;
    if (tenantId) {
        await db_1.pool.query(`select set_config('app.tenant_id', $1, true)`, [String(tenantId)]);
    }
}
function getTenantId(req) {
    return (req.session?.tenant_id || req.headers["x-tenant-id"] || null) ?? null;
}
/* ── Routes ─────────────────────────────────────────────────────────── */
/**
 * NOTE: We keep the endpoint the same (/api/admin/custom-fields),
 * but we now talk to public.custom_field_definition under the hood.
 */
// GET /api/admin/custom-fields?entity=lead&company_id=&pipeline_id=&include_global=1
router.get("/", async (req, res, next) => {
    try {
        await hydrateSession(req);
        await setTenant(req);
        const tenantId = getTenantId(req);
        if (!tenantId)
            return res.status(401).json({ error: "unauthorized", message: "Missing tenant/session" });
        const { entity = "lead", company_id = null, pipeline_id = null } = req.query;
        const includeGlobal = String(req.query.include_global ?? "1") !== "0";
        // Build WHERE for scoping: include global (NULL) plus the specific scope
        const wh = [`tenant_id = $1`, `entity = $2`];
        const vals = [tenantId, entity];
        // Scoping rules: (global) OR (matches company/pipeline)
        // We do it explicitly for clarity.
        if (includeGlobal) {
            wh.push(`
        (
          (company_id is null and pipeline_id is null)
          OR
          ( ($3::uuid is not null and company_id = $3) OR ($3::uuid is null and company_id is null) )
          OR
          ( ($4::uuid is not null and pipeline_id = $4) OR ($4::uuid is null and pipeline_id is null) )
        )
      `);
        }
        else {
            wh.push(`(company_id = $3 or $3::uuid is null)`);
            wh.push(`(pipeline_id = $4 or $4::uuid is null)`);
        }
        vals.push(company_id || null, pipeline_id || null);
        const sql = `
      select id, tenant_id, company_id, pipeline_id, entity, key, label,
             field_type, options, required, visible, sort_order, metadata,
             created_by, created_at
        from public.custom_field_definition
       where ${wh.join(" and ")}
       order by sort_order asc, label asc
    `;
        const r = await db_1.pool.query(sql, vals);
        // Keep response shape backward-compatible with the old route
        res.json({ items: r.rows });
    }
    catch (e) {
        next(e);
    }
});
// POST /api/admin/custom-fields
router.post("/", async (req, res, next) => {
    try {
        await hydrateSession(req);
        await setTenant(req);
        const tenantId = getTenantId(req);
        if (!tenantId)
            return res.status(401).json({ error: "unauthorized", message: "Missing tenant/session" });
        const { entity = "lead", key, label, field_type, options = null, required = false, visible = true, sort_order = 100, metadata = {}, company_id = null, pipeline_id = null, } = req.body || {};
        if (!key || !label || !field_type) {
            return res.status(400).json({ error: "invalid", message: "key, label, field_type are required" });
        }
        const normKey = String(key).trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
        const r = await db_1.pool.query(`insert into public.custom_field_definition
         (tenant_id, company_id, pipeline_id, entity, key, label, field_type,
          options, required, visible, sort_order, metadata, created_by)
       values
         ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       returning id`, [
            tenantId, company_id, pipeline_id, entity, normKey, label, field_type,
            options, required, visible, sort_order, metadata, req.session?.user_id ?? null
        ]);
        res.status(201).json({ id: r.rows[0].id });
    }
    catch (e) {
        if (e.code === "23505") {
            // from unique (tenant_id, company_id, pipeline_id, entity, key)
            return res.status(409).json({ error: "conflict", message: "Field key already exists for this scope" });
        }
        next(e);
    }
});
// PATCH /api/admin/custom-fields/:id
router.patch("/:id", async (req, res, next) => {
    try {
        await hydrateSession(req);
        await setTenant(req);
        const tenantId = getTenantId(req);
        if (!tenantId)
            return res.status(401).json({ error: "unauthorized", message: "Missing tenant/session" });
        const { id } = req.params;
        if (!isUuid(id))
            return res.status(400).json({ error: "bad_request", message: "id must be a UUID" });
        const exists = await db_1.pool.query(`select 1 from public.custom_field_definition where id=$1 and tenant_id=$2`, [id, tenantId]);
        if (exists.rowCount === 0)
            return res.status(404).json({ error: "not_found" });
        const cols = [];
        const vals = [];
        let i = 1;
        for (const [k, v] of Object.entries(req.body || {})) {
            if ([
                "entity", "key", "label", "field_type", "options", "required",
                "visible", "sort_order", "metadata", "company_id", "pipeline_id"
            ].includes(k)) {
                cols.push(`${k} = $${++i}`);
                vals.push(k === "key" ? String(v).trim().toLowerCase().replace(/[^a-z0-9_]/g, "_") : v);
            }
        }
        if (cols.length === 0)
            return res.json({ ok: true });
        vals.unshift(id);
        const sql = `update public.custom_field_definition set ${cols.join(", ")}, created_at = created_at where id=$1`;
        // (no updated_at column in your DDL; if you add one, set it here)
        await db_1.pool.query(sql, vals);
        res.json({ ok: true });
    }
    catch (e) {
        if (e.code === "23505") {
            return res.status(409).json({ error: "conflict", message: "Field key already exists for this scope" });
        }
        next(e);
    }
});
// DELETE /api/admin/custom-fields/:id
router.delete("/:id", async (req, res, next) => {
    try {
        await hydrateSession(req);
        await setTenant(req);
        const tenantId = getTenantId(req);
        if (!tenantId)
            return res.status(401).json({ error: "unauthorized", message: "Missing tenant/session" });
        const { id } = req.params;
        if (!isUuid(id))
            return res.status(400).json({ error: "bad_request", message: "id must be a UUID" });
        const r = await db_1.pool.query(`delete from public.custom_field_definition where id=$1 and tenant_id=$2`, [id, tenantId]);
        if (r.rowCount === 0)
            return res.status(404).json({ error: "not_found" });
        // Values cascade via FK when a definition is deleted
        res.json({ ok: true });
    }
    catch (e) {
        next(e);
    }
});
exports.default = router;
