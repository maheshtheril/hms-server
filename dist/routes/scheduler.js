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
const express_1 = require("express");
const cookie = __importStar(require("cookie"));
const db_1 = require("../db");
const sessionService_1 = require("../services/sessionService");
const router = (0, express_1.Router)();
console.log("[scheduler.ts] LOADED FROM", __filename);
// ──────────────────────────────────────────────────────────────────────────────
// auth (same as in leads.ts)
// ──────────────────────────────────────────────────────────────────────────────
async function requireSession(req, res, next) {
    try {
        const cookiesObj = cookie.parse(req.headers.cookie || "");
        const sid = cookiesObj.sid || cookiesObj.ssr_sid;
        if (!sid)
            return res.status(401).json({ error: "unauthenticated" });
        const sess = await (0, sessionService_1.findSessionBySid)(sid);
        if (!sess)
            return res.status(401).json({ error: "invalid_session" });
        req.session = { sid: sess.sid, user_id: sess.user_id, tenant_id: sess.tenant_id };
        (0, sessionService_1.touchSession)(sid).catch(() => { });
        next();
    }
    catch (err) {
        next(err);
    }
}
/**
 * GET /api/scheduler/leads?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD
 * Returns calendar-friendly “events” from:
 *  - lead.meta.follow_up_date (YYYY-MM-DD)
 *  - lead_task.due_date (DATE)
 */
router.get("/leads", requireSession, async (req, res, next) => {
    const tenantId = req.session?.tenant_id;
    const userId = req.session?.user_id;
    if (!tenantId || !userId)
        return res.status(400).json({ error: "tenant_id_missing_in_session" });
    // parse dates; treat date_to as exclusive (half-open interval)
    const df = String(req.query.date_from || "").slice(0, 10);
    const dt = String(req.query.date_to || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(df) || !/^\d{4}-\d{2}-\d{2}$/.test(dt)) {
        return res.status(400).json({ error: "invalid_dates" });
    }
    const cx = await db_1.pool.connect();
    try {
        await cx.query("BEGIN");
        await cx.query(`select set_config('app.tenant_id', $1::text, true)`, [tenantId]);
        await cx.query(`select set_config('app.user_id',   $1::text, true)`, [userId]);
        // Follow-ups from lead.meta.follow_up_date (string YYYY-MM-DD)
        const followupsQ = await cx.query(`
      select
        l.id                           as lead_id,
        l.name                         as lead_name,
        (l.meta->>'follow_up_date')::date as date,
        l.status                       as lead_status
      from public.lead l
      where (l.meta ? 'follow_up_date')
        and (l.meta->>'follow_up_date') ~ '^\d{4}-\d{2}-\d{2}$'
        and (l.meta->>'follow_up_date')::date >= $1::date
        and (l.meta->>'follow_up_date')::date <  $2::date
      order by date, lead_name
      `, [df, dt]);
        // Lead tasks in the window
        const tasksQ = await cx.query(`
      select
        t.id         as task_id,
        l.id         as lead_id,
        l.name       as lead_name,
        t.title      as task_title,
        t.due_date   as date,
        t.status     as task_status
      from public.lead_task t
      join public.lead l
        on l.id = t.lead_id
       and l.tenant_id = t.tenant_id
      where t.due_date >= $1::date
        and t.due_date <  $2::date
      order by date, lead_name
      `, [df, dt]);
        await cx.query("COMMIT");
        // normalize to a single array of events that the calendar can consume
        const events = [
            ...followupsQ.rows.map((r) => ({
                id: `fup:${r.lead_id}:${r.date}`,
                type: "follow_up",
                date: r.date, // YYYY-MM-DD
                title: `${r.lead_name} — Follow-up`,
                lead_id: r.lead_id,
                lead_name: r.lead_name,
                status: r.lead_status,
            })),
            ...tasksQ.rows.map((r) => ({
                id: `task:${r.task_id}`,
                type: "task",
                date: r.date, // YYYY-MM-DD
                title: `${r.lead_name} — ${r.task_title}`,
                lead_id: r.lead_id,
                lead_name: r.lead_name,
                status: r.task_status,
                task_id: r.task_id,
            })),
        ];
        res.json({ events });
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
exports.default = router;
