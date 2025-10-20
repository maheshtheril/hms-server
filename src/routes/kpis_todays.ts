import { Router } from "express";
import { pool } from "../db";
import * as cookie from "cookie";
import { findSessionBySid, touchSession } from "../services/sessionService";

const router = Router();

/*─────────────────────────────────────────────
  Reuse requireSession (simplified local copy)
─────────────────────────────────────────────*/
async function requireSession(req: any, res: any, next: any) {
  try {
    const cookies = cookie.parse(req.headers.cookie || "");
    const sid = cookies.sid || cookies.ssr_sid;
    if (!sid) return res.status(401).json({ error: "unauthenticated" });

    const sess = await findSessionBySid(sid);
    if (!sess) return res.status(401).json({ error: "invalid_session" });

    const headerCompany = (req.headers["x-company-id"] as string | undefined)?.trim();
    const cookieCompany = (cookies.cid as string | undefined)?.trim();

    req.session = {
      sid: sess.sid,
      user_id: sess.user_id,
      tenant_id: sess.tenant_id,
      company_id: headerCompany || cookieCompany || (sess as any).company_id || null,
    };

    touchSession(sid).catch((err: any) => console.error("touchSession error:", err));
    next();
  } catch (e) {
    console.error("requireSession failed:", e);
    return res.status(500).json({ error: "session_failed" });
  }
}

/*─────────────────────────────────────────────
  GET /kpis/todays → tenant-wide follow-up count
─────────────────────────────────────────────*/
router.get("/kpis/todays", requireSession, async (req: any, res: any) => {
  const tenantId = req.session?.tenant_id || String(req.query.tenantId || "");
  if (!tenantId) return res.status(400).json({ error: "tenant_id_required" });

  const cx = await pool.connect();
  try {
    // detect table name (lead or leads)
    const tableCheck = await cx.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND table_name IN ('lead','leads') LIMIT 1`
    );
    const tableName = tableCheck.rowCount > 0 ? tableCheck.rows[0].table_name : "lead";

    const sql = `
      WITH vars AS (
        SELECT $1::uuid AS tenant_id,
               to_char((NOW() AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS today_ist
      ),
      lead_dates AS (
        SELECT
          l.id,
          trim(coalesce(
            l.meta       ->> 'follow_up_date',
            l.meta       ->> 'followup_date',
            l.meta       ->> 'followUpDate',
            l.meta       ->> 'followupDate',
            l.metadata   ->> 'follow_up_date',
            l.metadata   ->> 'followup_date',
            l.metadata   ->> 'followUpDate',
            l.metadata   ->> 'followupDate',
            l.custom_data->> 'follow_up_date',
            l.custom_data->> 'followup_date',
            l.custom_data->> 'followUpDate',
            l.custom_data->> 'followupDate'
          ), '') AS raw_date
        FROM public.${tableName} l
        JOIN vars v ON l.tenant_id = v.tenant_id
      ),
      normalized AS (
        SELECT
          id,
          raw_date,
          (regexp_matches(raw_date, '(\\d{4}-\\d{2}-\\d{2})'))[1] AS ymd
        FROM lead_dates
      )
      SELECT COUNT(*)::int AS todays_followups
      FROM normalized n
      JOIN vars v ON true
      WHERE n.ymd = v.today_ist;
    `;

    const result = await cx.query(sql, [tenantId]);
    const count = result?.rows?.[0]?.todays_followups ?? 0;
    return res.json({ todays_followups: Number(count) });
  } catch (err) {
    console.error("GET /kpis/todays error:", err);
    return res.status(500).json({ error: "internal" });
  } finally {
    try {
      cx.release(true);
    } catch (e) {
      console.error("release error:", e);
    }
  }
});

export default router;
