import { Router } from "express";
import * as cookie from "cookie";
import { pool } from "../db";
import { findSessionBySid, touchSession } from "../services/sessionService";

const router = Router();
console.log("[scheduler.ts] LOADED FROM", __filename);

// ──────────────────────────────────────────────────────────────────────────────
// auth (same as in leads.ts)
// ──────────────────────────────────────────────────────────────────────────────
async function requireSession(req: any, res: any, next: any) {
  try {
    const cookiesObj = cookie.parse(req.headers.cookie || "");
    const sid = cookiesObj.sid || cookiesObj.ssr_sid;
    if (!sid) return res.status(401).json({ error: "unauthenticated" });

    const sess = await findSessionBySid(sid);
    if (!sess) return res.status(401).json({ error: "invalid_session" });

    req.session = { sid: sess.sid, user_id: sess.user_id, tenant_id: sess.tenant_id };
    touchSession(sid).catch(() => {});
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/scheduler/leads?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD
 * Returns calendar-friendly “events” from:
 *  - lead.meta.follow_up_date (YYYY-MM-DD)
 *  - lead_task.due_date (DATE)
 */
router.get("/leads", requireSession, async (req: any, res: any, next: any) => {
  const tenantId = req.session?.tenant_id as string | null;
  const userId   = req.session?.user_id as string | null;
  if (!tenantId || !userId) return res.status(400).json({ error: "tenant_id_missing_in_session" });

  // parse dates; treat date_to as exclusive (half-open interval)
  const df = String(req.query.date_from || "").slice(0, 10);
  const dt = String(req.query.date_to   || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(df) || !/^\d{4}-\d{2}-\d{2}$/.test(dt)) {
    return res.status(400).json({ error: "invalid_dates" });
  }

  const cx = await pool.connect();
  try {
    await cx.query("BEGIN");
    await cx.query(`select set_config('app.tenant_id', $1::text, true)`, [tenantId]);
    await cx.query(`select set_config('app.user_id',   $1::text, true)`, [userId]);

    // Follow-ups from lead.meta.follow_up_date (string YYYY-MM-DD)
    const followupsQ = await cx.query(
      `
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
      `,
      [df, dt]
    );

    // Lead tasks in the window
    const tasksQ = await cx.query(
      `
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
      `,
      [df, dt]
    );

    await cx.query("COMMIT");

    // normalize to a single array of events that the calendar can consume
    const events = [
      ...followupsQ.rows.map((r: any) => ({
        id: `fup:${r.lead_id}:${r.date}`,
        type: "follow_up",
        date: r.date,                 // YYYY-MM-DD
        title: `${r.lead_name} — Follow-up`,
        lead_id: r.lead_id,
        lead_name: r.lead_name,
        status: r.lead_status,
      })),
      ...tasksQ.rows.map((r: any) => ({
        id: `task:${r.task_id}`,
        type: "task",
        date: r.date,                 // YYYY-MM-DD
        title: `${r.lead_name} — ${r.task_title}`,
        lead_id: r.lead_id,
        lead_name: r.lead_name,
        status: r.task_status,
        task_id: r.task_id,
      })),
    ];

    res.json({ events });
  } catch (err) {
    try { await cx.query("ROLLBACK"); } catch {}
    next(err);
  } finally {
    cx.release();
  }
});

export default router;
