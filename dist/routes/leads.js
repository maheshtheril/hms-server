"use strict";
// routes/leads.ts  (PASTE-OVER REPLACEMENT)
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
const cookie = __importStar(require("cookie"));
const express_1 = require("express");
const db_1 = require("../db");
const sessionService_1 = require("../services/sessionService");
const router = (0, express_1.Router)();
console.log("[leads.ts] LOADED FROM", __filename);
/* ────────────────────────────────────────────────────────────────────────────
   Auth middleware → puts tenant_id, user_id, company_id on req.session
   Accepts optional company switch via header `x-company-id` or cookie `cid`
──────────────────────────────────────────────────────────────────────────── */
async function requireSession(req, res, next) {
    try {
        const cookiesObj = cookie.parse(req.headers.cookie || "");
        const sid = cookiesObj.sid || cookiesObj.ssr_sid;
        if (!sid)
            return res.status(401).json({ error: "unauthenticated" });
        const sess = await (0, sessionService_1.findSessionBySid)(sid); // ideally returns { sid, user_id, tenant_id, company_id? }
        if (!sess)
            return res.status(401).json({ error: "invalid_session" });
        const headerCompany = req.headers["x-company-id"]?.trim();
        const cookieCompany = cookiesObj.cid?.trim();
        req.session = {
            sid: sess.sid,
            user_id: sess.user_id,
            tenant_id: sess.tenant_id,
            company_id: (headerCompany || cookieCompany || sess.company_id || null) || null,
        };
        (0, sessionService_1.touchSession)(sid).catch(() => { });
        next();
    }
    catch (err) {
        next(err);
    }
}
/* ────────────────────────────────────────────────────────────────────────────
   Helpers
──────────────────────────────────────────────────────────────────────────── */
async function getAdminFlags(cx, tenantId, userId) {
    try {
        const q = await cx.query(`select
         coalesce(is_platform_admin, false) as is_platform_admin,
         coalesce(is_tenant_admin,  false) as is_tenant_admin,
         coalesce(is_admin,         false) as is_admin
       from public.app_user
      where id = $1 and tenant_id = $2
      limit 1`, [userId, tenantId]);
        const r = q.rows[0] || {};
        return {
            isPlatformAdmin: !!r.is_platform_admin,
            isTenantAdmin: !!r.is_tenant_admin,
            isAdmin: !!r.is_admin,
        };
    }
    catch {
        return { isPlatformAdmin: false, isTenantAdmin: false, isAdmin: false };
    }
}
async function setAppContext(cx, tenantId, userId, companyId) {
    await cx.query(`select set_config('app.tenant_id', $1::text, true)`, [tenantId]);
    await cx.query(`select set_config('app.user_id',   $1::text, true)`, [userId]);
    if (companyId) {
        await cx.query(`select set_config('app.company_id', $1::text, true)`, [companyId]);
    }
}
/** Resolve a sensible default company when session doesn’t have it */
async function resolveDefaultCompanyId(cx, tenantId, userId) {
    // 1) user default
    const u = await cx.query(`select company_id from public.app_user where id = $1 and tenant_id = $2 limit 1`, [userId, tenantId]);
    if (u.rows[0]?.company_id)
        return u.rows[0].company_id;
    // 2) single company fallback
    const companies = await cx.query(`select id from public.company where tenant_id = $1`, [tenantId]);
    if (companies.rowCount === 1)
        return companies.rows[0].id;
    return null;
}
/* ────────────────────────────────────────────────────────────────────────────
   POST /api/leads/:id/restore
──────────────────────────────────────────────────────────────────────────── */
router.post("/leads/:id/restore", requireSession, async (req, res, next) => {
    const tenantId = req.session?.tenant_id;
    const userId = req.session?.user_id;
    const leadId = req.params.id;
    if (!tenantId || !userId)
        return res.status(401).json({ error: "unauthenticated" });
    const cx = await db_1.pool.connect();
    try {
        await cx.query("BEGIN");
        await setAppContext(cx, tenantId, userId, req.session?.company_id);
        const upd = await cx.query(`
      update public.lead
         set meta = jsonb_strip_nulls( (coalesce(meta, '{}'::jsonb) - 'deleted_at' - 'deleted_by') ),
             updated_at = now()
       where id = $1 and tenant_id = $2
       returning id
      `, [leadId, tenantId]);
        await cx.query("COMMIT");
        if (upd.rowCount === 0)
            return res.status(404).json({ error: "not_found" });
        return res.json({ ok: true, id: upd.rows[0].id });
    }
    catch (err) {
        try {
            await cx.query("ROLLBACK");
        }
        catch { }
        next(err);
    }
    finally {
        cx.release();
    }
});
/* ────────────────────────────────────────────────────────────────────────────
   DELETE /api/leads/:id  (soft delete)
──────────────────────────────────────────────────────────────────────────── */
router.delete("/leads/:id", requireSession, async (req, res, next) => {
    const tenantId = req.session?.tenant_id;
    const userId = req.session?.user_id;
    const leadId = req.params.id;
    if (!tenantId || !userId)
        return res.status(401).json({ error: "unauthenticated" });
    const cx = await db_1.pool.connect();
    try {
        await cx.query("BEGIN");
        await setAppContext(cx, tenantId, userId, req.session?.company_id);
        const upd = await cx.query(`
      update public.lead
         set meta = jsonb_strip_nulls(
               coalesce(meta, '{}'::jsonb) ||
               jsonb_build_object('deleted_at', to_jsonb(now()), 'deleted_by', to_jsonb($3::uuid))
             ),
             updated_at = now()
       where id = $1
         and tenant_id = $2
         and (meta->>'deleted_at') is null
       returning id
      `, [leadId, tenantId, userId]);
        await cx.query("COMMIT");
        if (upd.rowCount === 0)
            return res.status(404).json({ error: "not_found_or_already_deleted" });
        return res.status(204).end();
    }
    catch (err) {
        try {
            await cx.query("ROLLBACK");
        }
        catch { }
        next(err);
    }
    finally {
        cx.release();
    }
});
/* ────────────────────────────────────────────────────────────────────────────
   GET /api/leads  (include_deleted/only_deleted, owner filter)
──────────────────────────────────────────────────────────────────────────── */
router.get("/leads", requireSession, async (req, res, next) => {
    const tenantId = req.session?.tenant_id;
    const userId = req.session?.user_id;
    if (!tenantId || !userId)
        return res.status(400).json({ error: "tenant_id_missing_in_session" });
    const truthy = (v) => ["1", "true", "yes", "on"].includes(String(v ?? "").toLowerCase());
    const includeDeleted = truthy(req.query.include_deleted);
    const onlyDeleted = truthy(req.query.only_deleted);
    const ownerParam = (req.query.owner ? String(req.query.owner) : undefined);
    const deletedWhere = onlyDeleted
        ? "and (meta->>'deleted_at') is not null"
        : (includeDeleted ? "" : "and (meta->>'deleted_at') is null");
    const cx = await db_1.pool.connect();
    try {
        await setAppContext(cx, tenantId, userId, req.session?.company_id);
        const flags = await getAdminFlags(cx, tenantId, userId);
        const isAdminish = flags.isPlatformAdmin || flags.isTenantAdmin || flags.isAdmin;
        const effectiveOwner = isAdminish ? ownerParam : (ownerParam || userId);
        const params = [tenantId];
        let sql = `
      select
        id, tenant_id, company_id, owner_id, pipeline_id, stage_id,
        name,
        primary_email as email,
        coalesce(primary_phone, primary_phone_e164) as phone,
        primary_phone_e164,
        source_id, status, stage,
        estimated_value, probability, tags, meta,
        (meta->>'deleted_at') is not null          as deleted,
        (meta->>'deleted_at')::timestamptz         as deleted_at,
        (meta->>'deleted_by')::uuid                as deleted_by,
        created_by, created_at, updated_at
      from public.lead
      where tenant_id = $1
      ${deletedWhere}
    `;
        if (effectiveOwner) {
            params.push(effectiveOwner);
            sql += ` and owner_id = $${params.length}\n`;
        }
        sql += ` order by created_at desc`;
        const result = await cx.query(sql, params);
        res.json({ leads: result.rows });
    }
    catch (err) {
        next(err);
    }
    finally {
        cx.release();
    }
});
/* ────────────────────────────────────────────────────────────────────────────
   GET /api/leads/:id  (detail + notes + tasks)
──────────────────────────────────────────────────────────────────────────── */
router.get("/leads/:id", requireSession, async (req, res, next) => {
    const tenantId = req.session?.tenant_id;
    const userId = req.session?.user_id;
    const leadId = req.params.id;
    if (!tenantId || !userId)
        return res.status(400).json({ error: "tenant_id_missing_in_session" });
    const cx = await db_1.pool.connect();
    try {
        await setAppContext(cx, tenantId, userId, req.session?.company_id);
        const leadQ = await cx.query(`
      select
        id, tenant_id, company_id, owner_id, pipeline_id, stage_id,
        name,
        primary_email as email,
        coalesce(primary_phone, primary_phone_e164) as phone,
        primary_phone_e164,
        source_id, status, stage,
        estimated_value, probability, tags, meta,
        created_by, created_at, updated_at
      from public.lead
      where id = $1 and tenant_id = $2
      limit 1
      `, [leadId, tenantId]);
        if (leadQ.rowCount === 0)
            return res.status(404).json({ error: "not_found" });
        const notesQ = await cx.query(`
      select id, lead_id, body, author_id, created_at
      from public.lead_note
      where lead_id = $1 and tenant_id = $2
      order by created_at desc
      `, [leadId, tenantId]);
        const tasksQ = await cx.query(`
      select id, lead_id, title, status, due_date, assigned_to, created_by, created_at, completed_at
      from public.lead_task
      where lead_id = $1 and tenant_id = $2
      order by created_at desc
      `, [leadId, tenantId]);
        res.json({ lead: leadQ.rows[0], notes: notesQ.rows, tasks: tasksQ.rows });
    }
    catch (err) {
        next(err);
    }
    finally {
        cx.release();
    }
});
/* ────────────────────────────────────────────────────────────────────────────
   GET /api/leads/:id/history
──────────────────────────────────────────────────────────────────────────── */
router.get("/leads/:id/history", requireSession, async (req, res, next) => {
    const tenantId = req.session?.tenant_id;
    const userId = req.session?.user_id;
    const leadId = req.params.id;
    const cx = await db_1.pool.connect();
    try {
        await setAppContext(cx, tenantId, userId, req.session?.company_id);
        try {
            const q = await cx.query(`
        select
          h.id, h.lead_id, h.from_stage, h.to_stage, h.from_stage_id, h.to_stage_id,
          h.changed_by, u.name as changed_by_name, h.created_at
        from public.lead_stage_history h
        left join public.app_user u
          on u.id = h.changed_by and u.tenant_id = h.tenant_id
        where h.tenant_id = $1 and h.lead_id = $2
        order by h.created_at desc
        `, [tenantId, leadId]);
            return res.json({ history: q.rows });
        }
        catch (e) {
            if (e?.code === "42P01")
                return res.json({ history: [] });
            throw e;
        }
    }
    catch (err) {
        next(err);
    }
    finally {
        cx.release();
    }
});
/* ────────────────────────────────────────────────────────────────────────────
   POST /api/leads  (CREATE) → prefers session company id
──────────────────────────────────────────────────────────────────────────── */
router.post("/leads", requireSession, async (req, res, next) => {
    const { lead_name, name, title, email, phone, phone_e164, assigned_user_id, owner_id, company_id, estimated_value, probability, tags, source_id, pipeline_id, stage_id, meta, } = req.body || {};
    try {
        const finalName = String(lead_name || name || title || "").trim();
        if (!finalName)
            return res.status(400).json({ error: "lead_name_required" });
        const tenantId = req.session?.tenant_id;
        const userId = req.session?.user_id;
        if (!tenantId || !userId)
            return res.status(400).json({ error: "tenant_id_missing_in_session" });
        const estVal = estimated_value === undefined || estimated_value === null || estimated_value === ""
            ? null
            : Number(estimated_value);
        const prob = probability === undefined || probability === null || probability === ""
            ? null
            : Math.min(100, Math.max(0, Number(probability)));
        const tagArr = Array.isArray(tags) ? tags : [];
        const safeMeta = meta && typeof meta === "object" ? meta : {};
        const cx = await db_1.pool.connect();
        try {
            await cx.query("BEGIN");
            // resolve company
            let finalCompanyId = null;
            if (company_id) {
                const ok = await cx.query(`select 1 from public.company where id = $1 and tenant_id = $2 limit 1`, [company_id, tenantId]);
                if (ok.rowCount === 0) {
                    await cx.query("ROLLBACK");
                    return res.status(400).json({ error: "invalid_company_id" });
                }
                finalCompanyId = company_id;
            }
            else if (req.session?.company_id) {
                const ok = await cx.query(`select 1 from public.company where id = $1 and tenant_id = $2 limit 1`, [req.session.company_id, tenantId]);
                if (ok.rowCount)
                    finalCompanyId = req.session.company_id;
            }
            if (!finalCompanyId) {
                finalCompanyId = await resolveDefaultCompanyId(cx, tenantId, userId);
            }
            // OPTIONAL TEMP OVERRIDE (remove when company-switcher is live)
            if (!finalCompanyId) {
                finalCompanyId = "af3b367a-d61c-4748-9536-3fe94fe2d247";
            }
            if (!finalCompanyId) {
                await cx.query("ROLLBACK");
                return res.status(400).json({ error: "company_required" });
            }
            await setAppContext(cx, tenantId, userId, finalCompanyId);
            const ins = await cx.query(`
        insert into public.lead
          (tenant_id, company_id, owner_id, pipeline_id, stage_id,
           name, primary_email, primary_phone, primary_phone_e164,
           source_id, status,
           estimated_value, probability, tags, meta,
           created_by)
        values
          ($1,        $2,         $3,       $4,         $5,
           $6,        $7,          $8,       $9,
           $10,       $11,
           $12,       $13,         $14,      $15,
           $16)
        returning
          id, tenant_id, company_id, owner_id, pipeline_id, stage_id,
          name, primary_email as email,
          coalesce(primary_phone, primary_phone_e164) as phone,
          primary_phone_e164,
          source_id, status, stage,
          estimated_value, probability, tags, meta,
          created_by, created_at, updated_at
        `, [
                tenantId,
                finalCompanyId,
                (owner_id ?? assigned_user_id ?? userId) ?? null,
                pipeline_id ?? null,
                stage_id ?? null,
                finalName,
                email ?? null,
                null,
                (phone_e164 || phone) ?? null,
                source_id ?? null,
                "new",
                estVal,
                prob,
                tagArr,
                safeMeta,
                userId,
            ]);
            await cx.query("COMMIT");
            res.status(201).json({ lead: ins.rows[0] });
        }
        catch (err) {
            try {
                await cx.query("ROLLBACK");
            }
            catch { }
            if (err?.code === "23503") {
                return res.status(400).json({ error: "foreign_key_violation", detail: err?.detail });
            }
            next(err);
        }
        finally {
            cx.release();
        }
    }
    catch (err) {
        next(err);
    }
});
/* ────────────────────────────────────────────────────────────────────────────
   PATCH /api/leads/:id
──────────────────────────────────────────────────────────────────────────── */
router.patch("/leads/:id", requireSession, async (req, res, next) => {
    const tenantId = req.session?.tenant_id;
    const userId = req.session?.user_id;
    const leadId = req.params.id;
    if (!tenantId || !userId)
        return res.status(400).json({ error: "tenant_id_missing_in_session" });
    const { name, email, phone, phone_e164, status, stage, owner_id, company_id, pipeline_id, stage_id, estimated_value, probability, tags, meta, } = req.body || {};
    const tagArr = Array.isArray(tags) ? tags : undefined;
    const cx = await db_1.pool.connect();
    try {
        await cx.query("BEGIN");
        await setAppContext(cx, tenantId, userId, req.session?.company_id);
        const upd = await cx.query(`
      update public.lead
      set
        name = coalesce($2, name),
        primary_email = coalesce($3, primary_email),
        primary_phone_e164 = coalesce($4, primary_phone_e164),
        status = coalesce($5, status),
        stage = coalesce($6, stage),
        owner_id = coalesce($7, owner_id),
        company_id = coalesce($8, company_id),
        pipeline_id = coalesce($9, pipeline_id),
        stage_id = coalesce($10, stage_id),
        estimated_value = coalesce($11, estimated_value),
        probability = coalesce($12, probability),
        tags = coalesce($13, tags),
        meta = case
          when $14::jsonb is null then meta
          else jsonb_strip_nulls(coalesce(meta, '{}'::jsonb) || $14::jsonb)
        end,
        updated_at = now()
      where id = $1 and tenant_id = $15
      returning
        id, tenant_id, company_id, owner_id, pipeline_id, stage_id,
        name, primary_email as email,
        coalesce(primary_phone, primary_phone_e164) as phone,
        primary_phone_e164,
        source_id, status, stage,
        estimated_value, probability, tags, meta,
        created_by, created_at, updated_at
      `, [
            leadId,
            name ?? null,
            email ?? null,
            (phone_e164 ?? phone) ?? null,
            status ?? null,
            stage ?? null,
            owner_id ?? null,
            company_id ?? null,
            pipeline_id ?? null,
            stage_id ?? null,
            estimated_value !== undefined ? Number(estimated_value) : null,
            probability !== undefined ? Math.min(100, Math.max(0, Number(probability))) : null,
            tagArr ?? null,
            meta ?? null,
            tenantId,
        ]);
        await cx.query("COMMIT");
        if (upd.rowCount === 0)
            return res.status(404).json({ error: "not_found" });
        res.json({ lead: upd.rows[0] });
    }
    catch (err) {
        try {
            await cx.query("ROLLBACK");
        }
        catch { }
        next(err);
    }
    finally {
        cx.release();
    }
});
/* ────────────────────────────────────────────────────────────────────────────
   POST /leads/:id/move
──────────────────────────────────────────────────────────────────────────── */
router.post("/leads/:id/move", requireSession, async (req, res, next) => {
    const tenantId = req.session?.tenant_id;
    const userId = req.session?.user_id;
    const leadId = req.params.id;
    const { stage_id, stage } = req.body || {};
    if (!tenantId || !userId)
        return res.status(400).json({ error: "tenant_id_missing_in_session" });
    if (!stage_id && (!stage || !String(stage).trim())) {
        return res.status(400).json({ error: "stage_or_stage_id_required" });
    }
    const looksLikeUuid = (s) => typeof s === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
    const cx = await db_1.pool.connect();
    try {
        await cx.query("BEGIN");
        await setAppContext(cx, tenantId, userId, req.session?.company_id);
        let newStageName = null;
        let newStageId = null;
        let newPipelineId = null;
        async function probePipelineStageByIdOrName(key) {
            const cols = await cx.query(`select column_name from information_schema.columns
          where table_schema='public' and table_name='pipeline_stage'`);
            const set = new Set(cols.rows.map((r) => r.column_name));
            const hasTenant = set.has("tenant_id");
            { // by id
                const where = hasTenant ? "where id::text = $1 and tenant_id = $2" : "where id::text = $1";
                const params = hasTenant ? [key, tenantId] : [key];
                const q = await cx.query(`select id, name, pipeline_id from public.pipeline_stage ${where} limit 1`, params);
                if ((q?.rowCount ?? 0) > 0)
                    return q.rows[0];
            }
            { // by name
                const where = hasTenant ? "where lower(name) = lower($1) and tenant_id = $2" : "where lower(name) = lower($1)";
                const params = hasTenant ? [key, tenantId] : [key];
                const q = await cx.query(`select id, name, pipeline_id from public.pipeline_stage ${where} limit 1`, params);
                if ((q?.rowCount ?? 0) > 0)
                    return q.rows[0];
            }
            return null;
        }
        async function resolveAsName(nameVal) {
            const nm = String(nameVal).trim();
            try {
                const rec = await probePipelineStageByIdOrName(nm);
                if (rec) {
                    newStageId = rec.id;
                    newStageName = rec.name;
                    newPipelineId = rec.pipeline_id ?? null;
                }
                else {
                    newStageId = null;
                    newStageName = nm;
                }
            }
            catch (e) {
                if (e?.code === "42P01") {
                    newStageId = null;
                    newStageName = nm;
                }
                else
                    throw e;
            }
        }
        if (stage && String(stage).trim()) {
            await resolveAsName(stage);
        }
        else if (stage_id) {
            if (!looksLikeUuid(stage_id)) {
                await resolveAsName(stage_id);
            }
            else {
                try {
                    const rec = await probePipelineStageByIdOrName(stage_id);
                    if (rec) {
                        newStageId = rec.id;
                        newStageName = rec.name;
                        newPipelineId = rec.pipeline_id ?? null;
                    }
                    else {
                        await resolveAsName(stage_id);
                    }
                }
                catch (e) {
                    if (e?.code === "42P01") {
                        newStageId = null;
                        newStageName = String(stage_id);
                    }
                    else
                        throw e;
                }
            }
        }
        if (!newStageName)
            return res.status(400).json({ error: "unable_to_resolve_stage" });
        const upd = await cx.query(`
      update public.lead
         set stage      = $3,
             stage_id   = $4,
             pipeline_id= coalesce($5, pipeline_id),
             updated_at = now()
       where id = $1 and tenant_id = $2
       returning id, stage, stage_id, pipeline_id, updated_at
      `, [leadId, tenantId, newStageName, newStageId, newPipelineId]);
        await cx.query("COMMIT");
        if (upd.rowCount === 0)
            return res.status(404).json({ error: "not_found" });
        res.json({ lead: upd.rows[0] });
    }
    catch (err) {
        try {
            await cx.query("ROLLBACK");
        }
        catch { }
        next(err);
    }
    finally {
        cx.release();
    }
});
/* ────────────────────────────────────────────────────────────────────────────
   Notes & Tasks
──────────────────────────────────────────────────────────────────────────── */
router.post("/leads/:id/notes", requireSession, async (req, res, next) => {
    const tenantId = req.session?.tenant_id;
    const userId = req.session?.user_id;
    const leadId = req.params.id;
    const { body } = req.body || {};
    if (!body || !String(body).trim())
        return res.status(400).json({ error: "note_body_required" });
    const cx = await db_1.pool.connect();
    try {
        await setAppContext(cx, tenantId, userId, req.session?.company_id);
        const ins = await cx.query(`
      insert into public.lead_note (tenant_id, lead_id, body, author_id)
      values ($1, $2, $3, $4)
      returning id, lead_id, body, author_id, created_at
      `, [tenantId, leadId, String(body), userId]);
        res.status(201).json({ note: ins.rows[0] });
    }
    catch (err) {
        next(err);
    }
    finally {
        cx.release();
    }
});
router.post("/leads/:id/tasks", requireSession, async (req, res, next) => {
    const tenantId = req.session?.tenant_id;
    const userId = req.session?.user_id;
    const leadId = req.params.id;
    const { title, due_date } = req.body || {};
    if (!title || !String(title).trim())
        return res.status(400).json({ error: "task_title_required" });
    const cx = await db_1.pool.connect();
    try {
        await setAppContext(cx, tenantId, userId, req.session?.company_id);
        const ins = await cx.query(`
      insert into public.lead_task (tenant_id, lead_id, title, status, due_date, created_by)
      values ($1, $2, $3, 'open', $4, $5)
      returning id, lead_id, title, status, due_date, assigned_to, created_by, created_at, completed_at
      `, [tenantId, leadId, String(title), due_date || null, userId]);
        res.status(201).json({ task: ins.rows[0] });
    }
    catch (err) {
        next(err);
    }
    finally {
        cx.release();
    }
});
router.patch("/leads/:id/tasks/:taskId", requireSession, async (req, res, next) => {
    const tenantId = req.session?.tenant_id;
    const userId = req.session?.user_id;
    const leadId = req.params.id;
    const taskId = req.params.taskId;
    const { status } = req.body || {};
    if (!["open", "done", "canceled"].includes(status))
        return res.status(400).json({ error: "invalid_status" });
    const cx = await db_1.pool.connect();
    try {
        await setAppContext(cx, tenantId, userId, req.session?.company_id);
        const upd = await cx.query(`
      update public.lead_task
      set status = $3,
          completed_at = case
            when $3 = 'done' then now()
            when $3 = 'open' then null
            else completed_at
          end
      where id = $2 and lead_id = $1 and tenant_id = $4
      returning id, lead_id, title, status, due_date, assigned_to, created_by, created_at, completed_at
      `, [leadId, taskId, status, tenantId]);
        if (upd.rowCount === 0)
            return res.status(404).json({ error: "not_found" });
        res.json({ task: upd.rows[0] });
    }
    catch (err) {
        next(err);
    }
    finally {
        cx.release();
    }
});
/* ────────────────────────────────────────────────────────────────────────────
   Close/Reopen
──────────────────────────────────────────────────────────────────────────── */
router.post("/leads/:id/close", requireSession, async (req, res, next) => {
    const tenantId = req.session?.tenant_id;
    const userId = req.session?.user_id;
    const leadId = req.params.id;
    const { outcome, reason } = req.body || {};
    if (!["won", "lost"].includes(outcome))
        return res.status(400).json({ error: "invalid_outcome" });
    const cx = await db_1.pool.connect();
    try {
        await setAppContext(cx, tenantId, userId, req.session?.company_id);
        const upd = await cx.query(`
      update public.lead
      set status = $3::text,
          stage  = $3::text,
          meta = jsonb_strip_nulls(
            coalesce(meta, '{}'::jsonb) ||
            jsonb_build_object('close', jsonb_build_object(
              'outcome', $3::text, 'reason', $4::text, 'at', now()
            ))
          ),
          updated_at = now()
      where id = $2 and tenant_id = $1
      returning id, status, stage, meta, updated_at
      `, [tenantId, leadId, outcome, reason || null]);
        if (upd.rowCount === 0)
            return res.status(404).json({ error: "not_found" });
        res.json({ lead: upd.rows[0] });
    }
    catch (err) {
        next(err);
    }
    finally {
        cx.release();
    }
});
router.post("/leads/:id/reopen", requireSession, async (req, res, next) => {
    const tenantId = req.session?.tenant_id;
    const userId = req.session?.user_id;
    const leadId = req.params.id;
    if (!tenantId || !userId)
        return res.status(400).json({ error: "tenant_id_missing_in_session" });
    const cx = await db_1.pool.connect();
    try {
        await setAppContext(cx, tenantId, userId, req.session?.company_id);
        const upd = await cx.query(`
      update public.lead
         set status = 'open',
             stage  = 'New',
             updated_at = now(),
             meta = jsonb_strip_nulls(
               (coalesce(meta, '{}'::jsonb) - 'close') ||
               jsonb_build_object('reopen', jsonb_build_object('by', $3, 'at', now()))
             )
       where id = $1 and tenant_id = $2
       returning id, status, stage, updated_at, meta
      `, [leadId, tenantId, userId]);
        if (upd.rowCount === 0)
            return res.status(404).json({ error: "not_found" });
        res.json({ lead: upd.rows[0] });
    }
    catch (err) {
        next(err);
    }
    finally {
        cx.release();
    }
});
/* ────────────────────────────────────────────────────────────────────────────
   GET /api/stages  (unified)
──────────────────────────────────────────────────────────────────────────── */
router.get("/stages", requireSession, async (req, res, next) => {
    const tenantId = req.session?.tenant_id;
    const userId = req.session?.user_id;
    if (!tenantId || !userId)
        return res.status(400).json({ error: "tenant_id_missing_in_session" });
    const cx = await db_1.pool.connect();
    try {
        await setAppContext(cx, tenantId, userId, req.session?.company_id);
        // 1) Prefer pipeline_stage if present
        try {
            try {
                const q = await cx.query(`
          select id, name, pipeline_id, order_index
            from public.pipeline_stage
           where tenant_id = $1
           order by coalesce(order_index, 9999), name
          `, [tenantId]);
                if ((q?.rowCount ?? 0) > 0)
                    return res.json({ stages: q.rows });
            }
            catch (e) {
                if (e?.code === "42703") {
                    const cols = await cx.query(`
            select column_name
              from information_schema.columns
             where table_schema='public' and table_name='pipeline_stage'
            `);
                    const set = new Set(cols.rows.map((r) => r.column_name));
                    const hasTenant = set.has("tenant_id");
                    const hasOrder = set.has("order_index");
                    const where = hasTenant ? "where tenant_id = $1" : "";
                    const params = hasTenant ? [tenantId] : [];
                    const selectOrderIndex = hasOrder ? "order_index" : "null::int as order_index";
                    const orderBy = hasOrder ? "coalesce(order_index, 9999), name" : "name";
                    const q2 = await cx.query(`
            select id, name, pipeline_id, ${selectOrderIndex}
              from public.pipeline_stage
              ${where}
             order by ${orderBy}
            `, params);
                    if ((q2?.rowCount ?? 0) > 0)
                        return res.json({ stages: q2.rows });
                }
                else {
                    throw e;
                }
            }
        }
        catch (e) {
            if (e?.code !== "42P01")
                console.warn("[/stages] pipeline_stage unavailable:", e?.code || e);
            // fall through
        }
        // 2) Fall back to lead_stage
        try {
            const colsQ = await cx.query(`
        select column_name
          from information_schema.columns
         where table_schema = 'public'
           and table_name   = 'lead_stage'
        `);
            const colset = new Set(colsQ.rows.map((r) => String(r.column_name)));
            const hasProb = colset.has("probability");
            const hasWon = colset.has("is_won");
            const hasLost = colset.has("is_lost");
            const hasOrder = colset.has("order_index");
            const hasCA = colset.has("created_at");
            const selectList = [
                "id",
                "name",
                hasProb ? "probability" : "null::int  as probability",
                hasWon ? "is_won" : "false      as is_won",
                hasLost ? "is_lost" : "false      as is_lost",
                hasOrder ? "order_index" : "null::int  as order_index",
                "null::uuid as pipeline_id",
                hasCA ? "created_at" : "now()      as created_at",
            ].join(", ");
            const orderBy = hasOrder ? "coalesce(order_index, 999999), name" : "name";
            const s = await cx.query(`
        select ${selectList}
          from public.lead_stage
         where tenant_id = $1
         order by ${orderBy}
        `, [tenantId]);
            if ((s?.rowCount ?? 0) > 0)
                return res.json({ stages: s.rows });
        }
        catch (e) {
            if (e?.code !== "42P01")
                throw e;
        }
        // 3) Final fallback: distinct lead.stage + defaults
        const defaults = ["New", "Qualified", "Proposal", "Negotiation", "Won", "Lost"];
        const distinct = await cx.query(`select distinct stage as name
         from public.lead
        where tenant_id = $1 and stage is not null
        order by name`, [tenantId]);
        const names = Array.from(new Set([...defaults, ...distinct.rows.map(r => String(r.name))]));
        const stages = names.map((name, i) => ({ id: name, name, pipeline_id: null, order_index: i }));
        res.json({ stages });
    }
    catch (err) {
        next(err);
    }
    finally {
        cx.release();
    }
});
/* ────────────────────────────────────────────────────────────────────────────
   Scheduler
──────────────────────────────────────────────────────────────────────────── */
router.get("/scheduler/leads", requireSession, async (req, res, next) => {
    const tenantId = req.session?.tenant_id;
    const userId = req.session?.user_id;
    const { date_from, date_to } = req.query || {};
    const page = Math.max(1, Number(req.query.page || 1));
    const pageSize = Math.min(1000, Math.max(1, Number(req.query.pageSize || 1000)));
    if (!tenantId || !userId)
        return res.status(401).json({ error: "unauthenticated" });
    if (!date_from || !date_to)
        return res.status(400).json({ error: "date_from_and_date_to_required" });
    const from = String(date_from).slice(0, 10);
    const to = String(date_to).slice(0, 10);
    const cx = await db_1.pool.connect();
    try {
        await setAppContext(cx, tenantId, userId, req.session?.company_id);
        const flags = await getAdminFlags(cx, tenantId, userId);
        const isAdminish = flags.isPlatformAdmin || flags.isTenantAdmin || flags.isAdmin;
        const ownerFilter = isAdminish ? (req.query.owner ? String(req.query.owner) : undefined) : userId;
        let sql1 = `
      select
        l.id                         as lead_id,
        l.name                       as lead_name,
        (l.meta->>'follow_up_date')::date as event_date,
        'lead_follow_up'             as kind,
        null::uuid                   as task_id,
        l.status                     as status
      from public.lead l
      where l.tenant_id = $1
        and (l.meta->>'follow_up_date') is not null
        and (l.meta->>'follow_up_date')::date between $2::date and $3::date
    `;
        const p1 = [tenantId, from, to];
        if (ownerFilter) {
            p1.push(ownerFilter);
            sql1 += ` and l.owner_id = $${p1.length}\n`;
        }
        const followUps = await cx.query(sql1, p1);
        let sql2 = `
      select
        t.lead_id                    as lead_id,
        l.name                       as lead_name,
        t.due_date::date             as event_date,
        'lead_task'                  as kind,
        t.id                         as task_id,
        t.status                     as status
      from public.lead_task t
      join public.lead l
        on l.id = t.lead_id
       and l.tenant_id = t.tenant_id
      where t.tenant_id = $1
        and t.status in ('open')
        and t.due_date between $2::date and $3::date
    `;
        const p2 = [tenantId, from, to];
        if (ownerFilter) {
            p2.push(ownerFilter);
            sql2 += ` and l.owner_id = $${p2.length}\n`;
        }
        const tasks = await cx.query(sql2, p2);
        const all = [...followUps.rows, ...tasks.rows]
            .filter(r => r.event_date)
            .sort((a, b) => a.event_date - b.event_date);
        const total = all.length;
        const start = (page - 1) * pageSize;
        const events = all.slice(start, start + pageSize);
        res.json({ events, items: events, total, page, pageSize, range: { from, to } });
    }
    catch (err) {
        next(err);
    }
    finally {
        cx.release();
    }
});
/* ────────────────────────────────────────────────────────────────────────────
   Custom Fields Upsert
──────────────────────────────────────────────────────────────────────────── */
// ✅ PUT /api/leads/:leadId/custom-fields/:definitionId
router.put("/:leadId/custom-fields/:definitionId", async (req, res) => {
    try {
        const tenantId = String(req.session?.tenant_id || "").trim();
        const userId = String(req.session?.user_id || "").trim();
        const { leadId, definitionId } = req.params;
        if (!tenantId)
            return res.status(401).json({ error: "No tenant in session" });
        if (!userId)
            return res.status(401).json({ error: "No user in session" });
        const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
        const isUuid = (v) => UUID_RX.test(v);
        if (!isUuid(leadId))
            return res.status(400).json({ error: "Invalid leadId" });
        if (!isUuid(definitionId))
            return res.status(400).json({ error: "Invalid definitionId" });
        const { value_text = null, value_number = null, value_boolean = null, value_json = null, } = req.body ?? {};
        // allow exactly one type
        const provided = [value_text, value_number, value_boolean, value_json].filter((v) => v !== null && v !== undefined);
        if (provided.length === 0) {
            return res.status(400).json({ error: "No value_* provided" });
        }
        if (provided.length > 1) {
            return res.status(400).json({
                error: "Provide only one of value_text / value_number / value_boolean / value_json",
            });
        }
        const sql = `
      INSERT INTO public.custom_field_value
        (definition_id, tenant_id, lead_id, value_text, value_number, value_boolean, value_json, created_by)
      VALUES
        ($1::uuid,       $2::uuid,  $3::uuid, $4::text, $5::numeric, $6::boolean, $7::jsonb,  $8::uuid)
      ON CONFLICT ON CONSTRAINT uq_cfv_tenant_lead_definition
      DO UPDATE SET
        value_text    = EXCLUDED.value_text,
        value_number  = EXCLUDED.value_number,
        value_boolean = EXCLUDED.value_boolean,
        value_json    = EXCLUDED.value_json,
        created_by    = EXCLUDED.created_by
      RETURNING id, definition_id, tenant_id, lead_id,
                value_text, value_number, value_boolean, value_json,
                created_by, created_at;
    `;
        const params = [
            definitionId, // $1
            tenantId, // $2
            leadId, // $3
            value_text, // $4
            value_number, // $5
            value_boolean, // $6
            value_json, // $7
            userId, // $8
        ];
        const { rows } = await db_1.pool.query(sql, params);
        return res.json({ ok: true, data: rows[0] });
    }
    catch (err) {
        console.error("[custom-field upsert] error:", err);
        return res.status(500).json({ error: "Internal Server Error", detail: err?.message });
    }
});
exports.default = router;
