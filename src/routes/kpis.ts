// server/src/routes/kpis.ts
import { Router } from "express";
import cookie from "cookie";
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

    req.session = { sid: sess.sid, user_id: sess.user_id, tenant_id: sess.tenant_id };
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
         FROM public.user_groups ug
         JOIN public.group_permissions gp ON gp.group_id = ug.group_id
         JOIN public.permissions p ON p.id = gp.permission_id
         WHERE ug.tenant_id = $1 AND ug.user_id = $2`,
        [tenantId, userId]
      );
      rows.forEach((r: any) => r?.t && tokens.add(String(r.t)));
    }
  } catch {}

  return Array.from(tokens).map((s) => s?.toString?.() ?? "").filter(Boolean);
}

function isAdminLikeToken(s: string) {
  // “admin”, “administrator”, “owner”, “sysadmin”, “root”, or permission codes like “admin.*”
  return /(admin|owner|administrator|sys\s*admin|sysadmin|root)/i.test(s) || /^admin(\.|:|_)/i.test(s);
}

router.get("/kpis", requireSession, async (req: any, res: any, next: any) => {
  const tenantId = req.session?.tenant_id;
  const userId = req.session?.user_id;
  if (!tenantId) return res.status(400).json({ error: "tenant_id_missing_in_session" });
  if (!userId) return res.status(400).json({ error: "user_id_missing_in_session" });

  const cx = await pool.connect();
  try {
    await cx.query("BEGIN");
    await cx.query(`SELECT set_config('app.tenant_id', $1::text, true)`, [String(tenantId)]);
    await cx.query(`SELECT set_config('app.user_id', $1::text, true)`, [String(userId)]);

    // Determine if user is admin-like
    const tokens = await fetchUserRoleTokens(cx, tenantId, userId);
    const isAdmin = tokens.some(isAdminLikeToken);

    // Query params
    const scope = String(req.query.scope ?? "").toLowerCase(); // "all" | "mine" | ""
    const mineParam = String(req.query.mine ?? "").toLowerCase();
    const mineRequested = mineParam === "1" || mineParam === "true" || scope === "mine";
    // If admin: honor request; if not: force mine
    const mine = isAdmin ? mineRequested : true;

    // ── Detect table + columns (prefer plural if both exist) ──
    const hasLeads = await tableExists(cx, "public", "leads");
    const hasLead = await tableExists(cx, "public", "lead");

    // Optional manual override for debugging: /api/kpis?table=leads or ?table=lead
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
      bare = "leads"; // ✅ prefer plural
    } else if (hasLead) {
      table = "public.lead";
      bare = "lead";
    } else {
      throw new Error("No table named public.leads or public.lead");
    }

    // Sanity count for the chosen table (current tenant)
    const { rows: sanity } = await cx.query(
      `SELECT COUNT(*)::int AS c FROM ${table} l WHERE l.tenant_id = $1`,
      [tenantId]
    );
    let chosenCount = sanity?.[0]?.c ?? 0;

    // Auto-fallback across lead/leads if the chosen has 0 rows but the other exists
    if (chosenCount === 0) {
      if (table === "public.leads" && hasLead) {
        const { rows: s2 } = await cx.query(
          `SELECT COUNT(*)::int AS c FROM public.lead l WHERE l.tenant_id = $1`,
          [tenantId]
        );
        const c2 = s2?.[0]?.c ?? 0;
        if (c2 > 0) {
          table = "public.lead";
          bare = "lead";
          chosenCount = c2;
        }
      } else if (table === "public.lead" && hasLeads) {
        const { rows: s2 } = await cx.query(
          `SELECT COUNT(*)::int AS c FROM public.leads l WHERE l.tenant_id = $1`,
          [tenantId]
        );
        const c2 = s2?.[0]?.c ?? 0;
        if (c2 > 0) {
          table = "public.leads";
          bare = "leads";
          chosenCount = c2;
        }
      }
    }

    // Detect follow-up column (follow_up_date | followup_date | meta->>'follow_up_date')
    const hasFollowUpDate = await columnExists(cx, "public", bare, "follow_up_date");
    const hasFollowupDate = !hasFollowUpDate && (await columnExists(cx, "public", bare, "followup_date"));
    const followExpr = hasFollowUpDate
      ? `l."follow_up_date"`
      : hasFollowupDate
      ? `l."followup_date"`
      : `NULLIF(l.meta->>'follow_up_date','')::timestamptz`;

    // Detect user-relations for scoping (assigned_user_id | owner_id | created_by)
    const hasAssigned = await columnExists(cx, "public", bare, "assigned_user_id");
    const hasOwner = await columnExists(cx, "public", bare, "owner_id");
    const hasCreatedBy = await columnExists(cx, "public", bare, "created_by");

    // Build mineClause respecting whichever user relations exist
    let mineClause = "";
    if (mine && (hasAssigned || hasOwner || hasCreatedBy)) {
      if (hasAssigned && hasOwner && hasCreatedBy) {
        mineClause = ` AND ($2 IN (l.assigned_user_id, l.owner_id, l.created_by)) `;
      } else if (hasAssigned && hasOwner) {
        mineClause = ` AND ($2 IN (l.assigned_user_id, l.owner_id)) `;
      } else if (hasAssigned) {
        mineClause = ` AND (l.assigned_user_id = $2) `;
      } else if (hasOwner) {
        mineClause = ` AND (l.owner_id = $2) `;
      } else {
        mineClause = ` AND (l.created_by = $2) `;
      }
    }

    // Treat statuses beginning with "closed" (closed, closed-won, closed_lost) as non-open
    const openStatusPredicate = `
      COALESCE(NULLIF(TRIM(lower(l.status)), ''), 'open') !~ '^(closed|closed[-_ ]?(won|lost))$'
    `;

    const sql = `
      WITH base AS (
        SELECT
          l.id,
          ${followExpr} AS fup
        FROM ${table} l
        WHERE l.tenant_id = $1
          AND ${openStatusPredicate}
          ${mineClause}
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

    const params = mine && (hasAssigned || hasOwner || hasCreatedBy) ? [tenantId, userId] : [tenantId];
    const { rows } = await cx.query(sql, params);
    const row = rows?.[0] ?? { open_leads: 0, todays_followups: 0 };

    await cx.query("COMMIT");

    console.log(
      `[kpis] table=${table} tenantRows=${chosenCount} scope=${mine ? "mine" : "all"} isAdmin=${isAdmin} tokens=${JSON.stringify(
        tokens
      )} open=${row.open_leads} today=${row.todays_followups}`
    );

    return res.json({
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
    next(err);
  } finally {
    cx.release();
  }
});

export default router;
