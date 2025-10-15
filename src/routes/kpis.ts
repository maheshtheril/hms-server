// server/src/routes/kpis.ts
import { Router } from "express";
import * as cookie from "cookie";
import { pool } from "../db";
import { findSessionBySid, touchSession } from "../services/sessionService";

const router = Router();

async function requireSession(req: any, res: any, next: any) {
  try {
    const cookies = cookie.parse(req.headers.cookie || "");
    const sid = cookies.sid || cookies.ssr_sid; // accept browser & SSR cookie
    if (!sid) return res.status(401).json({ error: "unauthenticated" });

    const sess = await findSessionBySid(sid);
    if (!sess) return res.status(401).json({ error: "invalid_session" });

    // include company_id if your session has it
    req.session = {
      sid: sess.sid,
      user_id: sess.user_id,
      tenant_id: sess.tenant_id,
      company_id: sess.company_id ?? null,
    };

    touchSession(sid).catch(() => {});
    next();
  } catch (e) {
    next(e);
  }
}

const IST_TZ = "Asia/Kolkata";

/* ───────────────── helpers ───────────────── */
async function tableExists(cx: any, schema: string, name: string): Promise<boolean> {
  const q = await cx.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2 LIMIT 1`,
    [schema, name]
  );
  return q.rowCount > 0;
}

async function columnExists(cx: any, schema: string, table: string, col: string): Promise<boolean> {
  const q = await cx.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name=$3 LIMIT 1`,
    [schema, table, col]
  );
  return q.rowCount > 0;
}

/** Collect role/permission “tokens” across common schemas and shapes. */
async function fetchUserRoleTokens(cx: any, tenantId: string, userId: string): Promise<string[]> {
  const tokens = new Set<string>();

  // A) user_roles ↔ roles
  try {
    const { rows } = await cx.query(
      `SELECT COALESCE(NULLIF(TRIM(r.code), ''), NULLIF(TRIM(r.name), '')) AS t
       FROM public.user_roles ur
       JOIN public.roles r ON r.id = ur.role_id
       WHERE ur.tenant_id = $1 AND ur.user_id = $2`,
      [tenantId, userId]
    );
    rows.forEach((r: any) => r?.t && tokens.add(String(r.t)));
  } catch {}

  // B) role_users ↔ roles
  try {
    const { rows } = await cx.query(
      `SELECT COALESCE(NULLIF(TRIM(r.code), ''), NULLIF(TRIM(r.name), '')) AS t
       FROM public.role_users ru
       JOIN public.roles r ON r.id = ru.role_id
       WHERE ru.tenant_id = $1 AND ru.user_id = $2`,
      [tenantId, userId]
    );
    rows.forEach((r: any) => r?.t && tokens.add(String(r.t)));
  } catch {}

  // C) users table variants
  try {
    const hasUsers = await tableExists(cx, "public", "users");
    if (hasUsers) {
      const { rows } = await cx.query(
        `SELECT role, role_code, roles, role_codes, is_admin
         FROM public.users
         WHERE tenant_id=$1 AND id=$2 LIMIT 1`,
        [tenantId, userId]
      );
      if (rows[0]) {
        const r = rows[0];
        if (r.role) tokens.add(String(r.role));
        if (r.role_code) tokens.add(String(r.role_code));
        if (Array.isArray(r.roles)) r.roles.forEach((x: any) => x && tokens.add(String(x)));
        if (Array.isArray(r.role_codes)) r.role_codes.forEach((x: any) => x && tokens.add(String(x)));
        if (r.is_admin === true) tokens.add("admin");
      }
    }
  } catch {}

  // D) user_groups ↔ groups
  try {
    const hasUG = await tableExists(cx, "public", "user_groups");
    const hasG = await tableExists(cx, "public", "groups");
    if (hasUG && hasG) {
      const { rows } = await cx.query(
        `SELECT COALESCE(NULLIF(TRIM(g.code), ''), NULLIF(TRIM(g.name), '')) AS t
         FROM public.user_groups ug
         JOIN public.groups g ON g.id = ug.group_id
         WHERE ug.tenant_id = $1 AND ug.user_id = $2`,
        [tenantId, userId]
      );
      rows.forEach((r: any) => r?.t && tokens.add(String(r.t)));
    }
  } catch {}

  // E) permissions via group_permissions
  try {
    const hasGP = await tableExists(cx, "public", "group_permissions");
    const hasP = await tableExists(cx, "public", "permissions");
    const hasUG = await tableExists(cx, "public", "user_groups");
    if (hasGP && hasP && hasUG) {
      const { rows } = await cx.query(
        `SELECT COALESCE(NULLIF(TRIM(p.code), ''), NULLIF(TRIM(p.name), '')) AS t
         FROM public.user_groups u
         JOIN public.group_permissions gp ON gp.group_id = u.group_id
         JOIN public.permissions p ON p.id = gp.permission_id
         WHERE u.tenant_id = $1 AND u.user_id = $2`,
        [tenantId, userId]
      );
      rows.forEach((r: any) => r?.t && tokens.add(String(r.t)));
    }
  } catch {}

  return Array.from(tokens).map((s) => s?.toString?.() ?? "").filter(Boolean);
}

function isAdminLikeToken(s: string) {
  // admin / owner / sysadmin / root and permission namespaces like admin.*
  return /(admin|owner|administrator|sys\s*admin|sysadmin|root)/i.test(s) || /^admin(\.|:|_)/i.test(s);
}
function isTenantAdminLikeToken(s: string) {
  // tenant/company admins or managers
  return /(tenant[_\s-]*admin|company[_\s-]*admin|manager)/i.test(s);
}

/* 
  GET /api/kpis
  Decides scope on the server:
    - admin / tenant-admin → totals ("all")
    - others (e.g., sales) → mine
*/
router.get("/kpis", requireSession, async (req: any, res: any) => {
  const tenantId = req.session?.tenant_id;
  const userId = req.session?.user_id;
  const companyId = req.session?.company_id ?? null;
  if (!tenantId) return res.status(400).json({ error: "tenant_id_missing_in_session" });
  if (!userId) return res.status(400).json({ error: "user_id_missing_in_session" });

  const cx = await pool.connect();
  try {
    await cx.query("BEGIN");
    await cx.query(`SELECT set_config('app.tenant_id', $1::text, true)`, [String(tenantId)]);
    await cx.query(`SELECT set_config('app.user_id', $1::text, true)`, [String(userId)]);
    if (companyId) {
      await cx.query(`SELECT set_config('app.company_id', $1::text, true)`, [String(companyId)]);
    }

    // Determine role class
    const tokens = await fetchUserRoleTokens(cx, tenantId, userId);
    const isAdmin = tokens.some(isAdminLikeToken) || tokens.some(isTenantAdminLikeToken);

    // Enforce scope server-side (ignore client query params)
    const mine = !isAdmin; // admin/tenant-admin → totals; others → mine
    const scope = mine ? "mine" : "all";

    // ── Detect table (prefer plural) ──
    const hasLeads = await tableExists(cx, "public", "leads");
    const hasLead = await tableExists(cx, "public", "lead");

    const tableOverride = String(req.query.table ?? "").toLowerCase().trim();
    let table: "public.leads" | "public.lead";
    let bare: "leads" | "lead";

    if (tableOverride === "leads" && hasLeads) {
      table = "public.leads";
      bare = "leads";
    } else if (tableOverride === "lead" && hasLead) {
      table = "public.lead";
      bare = "lead";
    } else if (hasLeads) {
      table = "public.leads";
      bare = "leads";
    } else if (hasLead) {
      table = "public.lead";
      bare = "lead";
    } else {
      // No table? Return safe zeros
      await cx.query("ROLLBACK");
      return res.json({
        scope,
        open_leads: 0,
        open_leads_count: 0,
        todays_followups: 0,
        followups_today: 0,
        open_leads_trend: "+0%",
        error: "no_leads_table",
      });
    }

    // Optional: sanity count for tenant rows
    const { rows: sanity } = await cx.query(
      `SELECT COUNT(*)::int AS c FROM ${table} l WHERE l.tenant_id = $1`,
      [tenantId]
    );
    const tenantCount = sanity?.[0]?.c ?? 0;

    // Detect columns we may use
    const hasFollowUpDate = await columnExists(cx, "public", bare, "follow_up_date");
    const hasFollowupDate = !hasFollowUpDate && (await columnExists(cx, "public", bare, "followup_date"));
    const hasAssigned = await columnExists(cx, "public", bare, "assigned_user_id");
    const hasOwner = await columnExists(cx, "public", bare, "owner_id");
    const hasCreatedBy = await columnExists(cx, "public", bare, "created_by");
    const hasCompanyId = await columnExists(cx, "public", bare, "company_id");

    const followExpr = hasFollowUpDate
      ? `l."follow_up_date"`
      : hasFollowupDate
      ? `l."followup_date"`
      : `NULLIF(l.meta->>'follow_up_date','')::timestamptz`;

    // Build WHERE fragments
    let where = `l.tenant_id = $1`;
    const params: any[] = [tenantId];

    if (hasCompanyId && companyId) {
      where += ` AND l.company_id = $${params.length + 1}`;
      params.push(companyId);
    }

    // ownership filter for "mine"
    if (mine && (hasAssigned || hasOwner || hasCreatedBy)) {
      if (hasAssigned && hasOwner && hasCreatedBy) {
        where += ` AND $${params.length + 1} IN (l.assigned_user_id, l.owner_id, l.created_by)`;
        params.push(userId);
      } else if (hasAssigned && hasOwner) {
        where += ` AND $${params.length + 1} IN (l.assigned_user_id, l.owner_id)`;
        params.push(userId);
      } else if (hasAssigned) {
        where += ` AND l.assigned_user_id = $${params.length + 1}`;
        params.push(userId);
      } else if (hasOwner) {
        where += ` AND l.owner_id = $${params.length + 1}`;
        params.push(userId);
      } else {
        where += ` AND l.created_by = $${params.length + 1}`;
        params.push(userId);
      }
    }

    // "Open" status (treat closed* as non-open)
    const openStatusPredicate = `
      COALESCE(NULLIF(TRIM(lower(l.status)), ''), 'open') !~ '^(closed|closed[-_ ]?(won|lost))$'
    `;

    const sql = `
      WITH base AS (
        SELECT l.id, ${followExpr} AS fup
        FROM ${table} l
        WHERE ${where}
          AND ${openStatusPredicate}
      )
      SELECT
        COUNT(*)::int AS open_leads,
        SUM(
          CASE
            WHEN fup IS NOT NULL
             AND ((fup AT TIME ZONE '${IST_TZ}')::date = (NOW() AT TIME ZONE '${IST_TZ}')::date)
            THEN 1 ELSE 0
          END
        )::int AS todays_followups
      FROM base;
    `;

    const { rows } = await cx.query(sql, params);
    const row = rows?.[0] ?? { open_leads: 0, todays_followups: 0 };

    await cx.query("COMMIT");

    console.log(
      `[kpis] table=${table} tenantRows=${tenantCount} scope=${scope} tokens=${JSON.stringify(
        tokens
      )} open=${row.open_leads} today=${row.todays_followups}`
    );

    return res.json({
      scope,
      open_leads_count: row.open_leads,
      open_leads: row.open_leads,
      todays_followups: row.todays_followups,
      followups_today: row.todays_followups,
      open_leads_trend: "+0%",
    });
  } catch (err) {
    try {
      await cx.query("ROLLBACK");
    } catch {}
    console.error("KPIs error:", err);
    // Return safe zeros so the UI never crashes
    return res.json({
      scope: "mine",
      open_leads_count: 0,
      open_leads: 0,
      todays_followups: 0,
      followups_today: 0,
      open_leads_trend: "+0%",
      error: "kpis_failed",
    });
  } finally {
    cx.release();
  }
});

export default router;
