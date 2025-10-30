"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/kpis.ts
const express_1 = require("express");
const db_1 = require("../db");
const sessionService_1 = require("../services/sessionService");
const router = (0, express_1.Router)();
console.log("[kpis.ts] LOADED FROM", __filename);
/**
 * Robust cookie parser: handles values that contain '='
 */
function parseCookies(cookieHeader) {
    const out = {};
    if (!cookieHeader)
        return out;
    const parts = cookieHeader
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean);
    for (const kv of parts) {
        const eq = kv.indexOf("=");
        if (eq === -1)
            continue;
        const key = kv.slice(0, eq).trim();
        const value = kv.slice(eq + 1).trim();
        try {
            out[key] = decodeURIComponent(value);
        }
        catch {
            out[key] = value;
        }
    }
    return out;
}
// diagnostic requireSession - replaces existing requireSession in routes/kpis.ts
async function requireSession(req, res, next) {
    try {
        // debug: what server receives
        console.log("[requireSession] incoming cookie header ->", req.headers.cookie);
        // parse cookie header into object using helper
        const cookies = parseCookies(req.headers.cookie);
        // try several common cookie names (robust)
        const sidCandidates = [
            "sid",
            "ssr_sid",
            "session",
            "__session",
            "session_id",
            "next-auth.session-token",
            "next-auth.callback-url",
            "sid_token",
        ];
        let sid = null;
        let sidName = null;
        for (const name of sidCandidates) {
            if (typeof cookies[name] === "string" && cookies[name].length > 0) {
                sid = cookies[name];
                sidName = name;
                break;
            }
        }
        // If still missing, also try to pick the longest cookie value (heuristic)
        if (!sid && Object.keys(cookies).length) {
            const sorted = Object.entries(cookies).sort((a, b) => b[1].length - a[1].length);
            const kv = sorted[0];
            if (kv && kv[1] && kv[1].length > 0) {
                sid = kv[1];
                sidName = kv[0];
            }
        }
        console.log("[requireSession] resolved sidName ->", sidName);
        if (!sid) {
            return res.status(401).json({ error: "unauthenticated" });
        }
        // find session by sid (imported at top)
        const sess = await (0, sessionService_1.findSessionBySid)(sid);
        if (!sess)
            return res.status(401).json({ error: "invalid_session" });
        req.session = {
            sid: sess.sid,
            user_id: sess.user_id,
            tenant_id: sess.tenant_id,
            company_id: (cookies.cid || sess.company_id) || null,
        };
        // touch session asynchronously (don't await)
        (0, sessionService_1.touchSession)(sid).catch(() => { });
        next();
    }
    catch (e) {
        next(e);
    }
}
/**
 * GET /todays
 * Response: { ok: true, todays_followups: number }
 */
router.get("/todays", requireSession, async (req, res, next) => {
    try {
        const tenantId = req.session?.tenant_id;
        const userId = req.session?.user_id;
        if (!tenantId)
            return res.status(401).json({ error: "unauthenticated" });
        const mine = String(req.query?.mine ?? "").toLowerCase() === "1" ||
            String(req.query?.mine ?? "").toLowerCase() === "true";
        const ownerParam = req.query?.owner ? String(req.query.owner) : null;
        const ownerFilter = mine ? userId : ownerParam;
        // create IST date string YYYY-MM-DD deterministically on server
        const istToday = new Date().toLocaleString("en-CA", { timeZone: "Asia/Kolkata" }).slice(0, 10);
        const cx = await db_1.pool.connect();
        try {
            // 1) determine whether lead_follow_ups table exists
            const tableCheckQ = await cx.query(`select 1 from information_schema.tables where table_schema='public' and table_name='lead_follow_ups' limit 1`);
            const hasLeadFollowUps = tableCheckQ.rowCount > 0;
            let total = 0;
            // A) leads with meta->>'follow_up_date' = today
            {
                const params = [tenantId, istToday];
                let ownerClause = "";
                if (ownerFilter) {
                    params.push(ownerFilter);
                    ownerClause = ` AND l.owner_id = $${params.length}`;
                }
                const leadMetaSql = `
          SELECT count(1)::int AS cnt
          FROM public.lead l
          WHERE l.tenant_id = $1
            AND (l.meta->>'follow_up_date')::date = $2
            AND (l.meta->>'deleted_at') IS NULL
            ${ownerClause}
        `;
                const q = await cx.query(leadMetaSql, params);
                total += Number(q.rows?.[0]?.cnt ?? 0);
            }
            // B) open lead_task due today
            {
                const params = [tenantId, istToday];
                let ownerClause = "";
                if (ownerFilter) {
                    params.push(ownerFilter);
                    ownerClause = ` AND l.owner_id = $${params.length}`;
                }
                const taskSql = `
          SELECT count(1)::int AS cnt
          FROM public.lead_task t
          JOIN public.lead l ON l.id = t.lead_id AND l.tenant_id = t.tenant_id
          WHERE t.tenant_id = $1
            AND t.status IN ('open')
            AND t.due_date::date = $2
            ${ownerClause}
        `;
                const q = await cx.query(taskSql, params);
                total += Number(q.rows?.[0]?.cnt ?? 0);
            }
            // C) optional lead_follow_ups table (scheduled_at)
            if (hasLeadFollowUps) {
                const params = [tenantId, istToday];
                let ownerClause = "";
                if (ownerFilter) {
                    params.push(ownerFilter);
                    ownerClause = ` AND l.owner_id = $${params.length}`;
                }
                // If scheduled_at is timestamptz, convert to Asia/Kolkata date for comparison:
                // Use (f.scheduled_at AT TIME ZONE 'Asia/Kolkata')::date when scheduled_at is timestamptz.
                const followUpSql = `
          SELECT count(1)::int AS cnt
          FROM public.lead_follow_ups f
          JOIN public.lead l ON l.id = f.lead_id AND l.tenant_id = f.tenant_id
          WHERE l.tenant_id = $1
            AND ( (f.scheduled_at AT TIME ZONE 'Asia/Kolkata')::date ) = $2
            AND coalesce(f.deleted, false) = false
            ${ownerClause}
        `;
                const q = await cx.query(followUpSql, params);
                total += Number(q.rows?.[0]?.cnt ?? 0);
            }
            return res.json({ ok: true, todays_followups: total });
        }
        finally {
            cx.release();
        }
    }
    catch (err) {
        next(err);
    }
});
exports.default = router;
