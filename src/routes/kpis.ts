// routes/kpis.ts
import { Router } from "express";
import { pool } from "../db";

const router = Router();
console.log("[kpis.ts] LOADED FROM", __filename);

// Reuse your requireSession from leads.ts (or re-import it if exported). 
// For convenience paste the same requireSession implementation here or import it.
async function requireSession(req: any, res: any, next: any) {
  try {
    // try to parse cookie->sid like your leads.ts does
    const cookies = (req.headers.cookie || "")
      .split(";")
      .map(s => s.trim())
      .filter(Boolean)
      .reduce((acc: any, kv: string) => {
        const [k, v] = kv.split("=");
        if (k && v) acc[k] = decodeURIComponent(v);
        return acc;
      }, {});
    const sid = cookies.sid || cookies.ssr_sid;
    if (!sid) return res.status(401).json({ error: "unauthenticated" });

    // findSessionBySid should exist like in leads.ts. If not, adapt to your session handling.
    const { findSessionBySid } = require("../services/sessionService");
    const sess = await findSessionBySid(sid);
    if (!sess) return res.status(401).json({ error: "invalid_session" });

    req.session = {
      sid: sess.sid,
      user_id: sess.user_id,
      tenant_id: sess.tenant_id,
      company_id: (cookies.cid || sess.company_id) || null,
    };

    // best-effort touch
    const { touchSession } = require("../services/sessionService");
    touchSession(sid).catch(() => {});
    next();
  } catch (e) {
    next(e);
  }
}

/**
 * GET /todays
 * Query params:
 *  - mine=1           -> count only leads owned by current user
 *  - owner=<uuid>     -> if current user is admin you can pass owner to count for specific owner
 *
 * Response: { ok: true, todays_followups: number }
 */
router.get("/todays", requireSession, async (req: any, res: any, next: any) => {
  try {
    const tenantId = req.session?.tenant_id as string | null;
    const userId = req.session?.user_id as string | null;
    if (!tenantId) return res.status(401).json({ error: "unauthenticated" });

    const mine = String(req.query?.mine ?? "").toLowerCase() === "1" || String(req.query?.mine ?? "").toLowerCase() === "true";
    const ownerParam = req.query?.owner ? String(req.query.owner) : null;

    // compute IST date string (YYYY-MM-DD) on server side to match calendar expectations
    const istToday = (new Date().toLocaleString("en-CA", { timeZone: "Asia/Kolkata" })).slice(0, 10);

    const cx = await pool.connect();
    try {
      // Set app context if you want like in other routes:
      // await setAppContext(cx, tenantId, userId, req.session?.company_id);

      // 1) determine whether lead_follow_ups table exists
      const tableCheckQ = await cx.query(
        `select 1 from information_schema.tables where table_schema='public' and table_name='lead_follow_ups' limit 1`
      );
      const hasLeadFollowUps = tableCheckQ.rowCount > 0;

      // 2) optional owner filtering: if mine => owner = userId, else if owner param provided use it.
      const ownerFilter = mine ? userId : ownerParam;

      // We'll build three counts and sum them:
      // - follow_up_date in lead.meta
      // - open lead_task due_date
      // - lead_follow_ups.scheduled_at (if table exists)

      const parts: string[] = [];
      const params: any[] = [tenantId, istToday]; // $1 tenant, $2 istToday
      let paramIndex = 2;

      // A) count leads with meta->>'follow_up_date' = today
      // note: ensure type cast to date & tenant scoping; ignore deleted (meta->>'deleted_at') if present
      paramIndex++;
      params.push(ownerFilter); // $3 if ownerFilter present; otherwise dummy placeholder not used
      const ownerClauseForLead = ownerFilter ? ` and l.owner_id = $${paramIndex}` : "";
      const leadMetaSql = `
        select count(1)::int as cnt from public.lead l
        where l.tenant_id = $1
          and (l.meta->>'follow_up_date')::date = $2
          and (l.meta->>'deleted_at') is null
          ${ownerClauseForLead}
      `;
      parts.push(leadMetaSql);

      // B) count open lead_task due today
      paramIndex++;
      params.push(ownerFilter);
      const ownerClauseForTask = ownerFilter ? ` and l.owner_id = $${paramIndex}` : "";
      const taskSql = `
        select count(1)::int as cnt
        from public.lead_task t
        join public.lead l on l.id = t.lead_id and l.tenant_id = t.tenant_id
        where t.tenant_id = $1
          and t.status in ('open')
          and t.due_date::date = $2
          ${ownerClauseForTask}
      `;
      parts.push(taskSql);

      // C) optional lead_follow_ups table: scheduled_at timestamp
      if (hasLeadFollowUps) {
        paramIndex++;
        params.push(ownerFilter);
        // compare scheduled_at after converting to IST date. Assume scheduled_at is timestamptz.
        const ownerClauseForFollowup = ownerFilter ? ` and l.owner_id = $${paramIndex}` : "";
        const followUpSql = `
          select count(1)::int as cnt
          from public.lead_follow_ups f
          join public.lead l on l.id = f.lead_id and l.tenant_id = f.tenant_id
          where l.tenant_id = $1
            and ( (f.scheduled_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata')::date = $2
            and coalesce(f.deleted, false) = false
            ${ownerClauseForFollowup}
        `;
        parts.push(followUpSql);
      }

      // Execute each count separately (safer and easier to debug)
      let total = 0;
      // For leadMeta
      {
        const q = await cx.query(parts[0], params.slice(0, ownerFilter ? 3 : 2));
        total += Number(q.rows?.[0]?.cnt ?? 0);
      }
      // For tasks
      {
        const taskParams = params.slice(0, ownerFilter ? 4 : 2);
        const q = await cx.query(parts[1], taskParams);
        total += Number(q.rows?.[0]?.cnt ?? 0);
      }
      // For lead_follow_ups (if present)
      if (hasLeadFollowUps && parts[2]) {
        const followParams = params.slice(0, ownerFilter ? (hasLeadFollowUps ? (ownerFilter ? 5 : 2) : 2) : 2);
        // simpler: build followParams explicitly
        const followParamsExplicit = ownerFilter ? [tenantId, istToday, ownerFilter] : [tenantId, istToday];
        const q = await cx.query(parts[2], followParamsExplicit);
        total += Number(q.rows?.[0]?.cnt ?? 0);
      }

      return res.json({ ok: true, todays_followups: total });
    } finally {
      cx.release();
    }
  } catch (err) {
    next(err);
  }
});

export default router;
