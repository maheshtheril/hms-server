// routes/kpis.ts  (FULL - drop-in replacement)
// Provides: GET /kpis and SSE /events/kpis with robust role discovery, schema-adaptive KPIs,
// IST timezone handling, and safe requireSession (company override via header/cookie).
import * as cookie from "cookie";
import { Router } from "express";
import { pool } from "../db";
import { findSessionBySid, touchSession } from "../services/sessionService";

const router = Router();
console.log("[kpis.ts] LOADED FROM", __filename);

/* ────────────────────────────────────────────────────────────────────────────
   Auth middleware → puts tenant_id, user_id, company_id on req.session
   Accepts optional company switch via header `x-company-id` or cookie `cid`.
   Logs touchSession errors instead of swallowing.
──────────────────────────────────────────────────────────────────────────── */
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
      company_id: (headerCompany || cookieCompany || (sess as any).company_id || null) || null,
    };

    touchSession(sid).catch((err: any) => console.error("touchSession error:", err));
    next();
  } catch (e) {
    next(e);
  }
}

const IST_TZ = "Asia/Kolkata";

/* ────────────────────────────────────────────────────────────────────────────
   Small helpers for introspecting DB schema
──────────────────────────────────────────────────────────────────────────── */
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

/* ────────────────────────────────────────────────────────────────────────────
   Role discovery across multiple possible auth schemas (user_roles, role_users,
   app_user, users, groups, permissions). Returns array of token strings.
──────────────────────────────────────────────────────────────────────────── */
async function fetchUserRoleTokens(cx: any, tenantId: string, userId: string): Promise<string[]> {
  const tokens = new Set<string>();
  try {
    const { rows } = await cx.query(
      `SELECT COALESCE(NULLIF(TRIM(r.code), ''), NULLIF(TRIM(r.name), '')) AS t
       FROM public.user_roles ur
       JOIN public.roles r ON r.id = ur.role_id
       WHERE ur.tenant_id = $1 AND ur.user_id = $2`,
      [tenantId, userId]
    );
    rows.forEach((r: any) => r?.t && tokens.add(String(r.t)));
  } catch (e) {
    void e;
  }

  try {
    const { rows } = await cx.query(
      `SELECT COALESCE(NULLIF(TRIM(r.code), ''), NULLIF(TRIM(r.name), '')) AS t
       FROM public.role_users ru
       JOIN public.roles r ON r.id = ru.role_id
       WHERE ru.tenant_id = $1 AND ru.user_id = $2`,
      [tenantId, userId]
    );
    rows.forEach((r: any) => r?.t && tokens.add(String(r.t)));
  } catch (e) {
    void e;
  }

  try {
    const hasAppUser = await tableExists(cx, "public", "app_user");
    if (hasAppUser) {
      const { rows } = await cx.query(
        `SELECT role, is_admin, is_tenant_admin
         FROM public.app_user
         WHERE tenant_id = $1 AND id = $2
         LIMIT 1`,
        [tenantId, userId]
      );
      if (rows[0]) {
        const r = rows[0];
        if (r.role) tokens.add(String(r.role));
        if (r.is_admin === true) tokens.add("admin");
        if (r.is_tenant_admin === true) tokens.add("tenant_admin");
      }
    }
  } catch (e) {
    void e;
  }

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
  } catch (e) {
    void e;
  }

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
  } catch (e) {
    void e;
  }

  try {
    const hasGP = await tableExists(cx, "public", "group_permissions");
    const hasP = await tableExists(cx, "public", "permissions");
    const hasUG2 = await tableExists(cx, "public", "user_groups");
    if (hasGP && hasP && hasUG2) {
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
  } catch (e) {
    void e;
  }

  return Array.from(tokens).map((s) => s?.toString?.() ?? "").filter(Boolean);
}

function isAdminLikeToken(s: string) {
  return /(admin|owner|administrator|sys\s*admin|sysadmin|root)/i.test(s) || /^admin(\.|:|_)/i.test(s);
}
function isTenantAdminLikeToken(s: string) {
  return /(tenant[_\s-]*admin|company[_\s-]*admin|manager)/i.test(s);
}

/* ────────────────────────────────────────────────────────────────────────────
   getAdminFlags - helper kept for compatibility with other code that expects
   explicit isPlatformAdmin/isTenantAdmin/isAdmin booleans.
──────────────────────────────────────────────────────────────────────────── */
async function getAdminFlags(cx: any, tenantId: string, userId: string) {
  try {
    const q = await cx.query(
      `select
         coalesce(is_platform_admin, false) as is_platform_admin,
         coalesce(is_tenant_admin,  false) as is_tenant_admin,
         coalesce(is_admin,         false) as is_admin
       from public.app_user
      where id = $1 and tenant_id = $2
      limit 1`,
      [userId, tenantId]
    );
    const r = q.rows[0] || {};
    return {
      isPlatformAdmin: !!r.is_platform_admin,
      isTenantAdmin:   !!r.is_tenant_admin,
      isAdmin:         !!r.is_admin,
    };
  } catch {
    return { isPlatformAdmin: false, isTenantAdmin: false, isAdmin: false };
  }
}

/* setAppContext — sets Postgres application GUCs for tenant/user/company */
async function setAppContext(cx: any, tenantId: string, userId: string, companyId?: string | null) {
  await cx.query(`select set_config('app.tenant_id', $1::text, true)`, [tenantId]);
  await cx.query(`select set_config('app.user_id',   $1::text, true)`, [userId]);
  if (companyId) {
    await cx.query(`select set_config('app.company_id', $1::text, true)`, [companyId]);
  }
}

/* Resolve default company if none provided in session */
async function resolveDefaultCompanyId(cx: any, tenantId: string, userId: string) {
  const u = await cx.query(
    `select company_id from public.app_user where id = $1 and tenant_id = $2 limit 1`,
    [userId, tenantId]
  );
  if (u.rows[0]?.company_id) return u.rows[0].company_id as string;

  const companies = await cx.query(`select id from public.company where tenant_id = $1`, [tenantId]);
  if (companies.rowCount === 1) return companies.rows[0].id as string;

  return null;
}

/* ────────────────────────────────────────────────────────────────────────────
   computeKpis - the main flexible KPI computation routine.
   - Adapts to table name variants (lead/leads), many follow-up locations,
     JSON containers, and chooses scope based on discovered role tokens.
──────────────────────────────────────────────────────────────────────────── */
async function computeKpis(
  cx: any,
  tenantId: string,
  userId: string,
  companyId: string | null,
  tableOverride?: string
) {
  const IST = IST_TZ;

  // choose table
  const hasLead = await tableExists(cx, "public", "lead");
  const hasLeads = await tableExists(cx, "public", "leads");

  const override = String(tableOverride ?? "").toLowerCase().trim();
  let table: string;
  let bare: string;

  if ((override === "lead" && hasLead) || (!override && hasLead)) {
    table = "public.lead";
    bare = "lead";
  } else if ((override === "leads" && hasLeads) || (!override && !hasLead && hasLeads)) {
    table = "public.leads";
    bare = "leads";
  } else {
    return {
      scope: "mine",
      open_leads_count: 0,
      open_leads: 0,
      todays_followups: 0,
      followups_today: 0,
      open_leads_trend: "+0%",
      error: "no_leads_table",
    };
  }

  // tenant count
  const sanityQ = await cx.query(`SELECT COUNT(*)::int AS c FROM ${table} l WHERE l.tenant_id = $1::uuid`, [tenantId]);
  const tenantCount = sanityQ?.rows?.[0]?.c ?? 0;

  const hasFollowUpDate = await columnExists(cx, "public", bare, "follow_up_date");
  const hasFollowupDate = !hasFollowUpDate && (await columnExists(cx, "public", bare, "followup_date"));

  // JSON meta candidates
  const metaCandidates: string[] = [];
  if (await columnExists(cx, "public", bare, "meta")) metaCandidates.push("l.meta");
  if (await columnExists(cx, "public", bare, "metadata")) metaCandidates.push("l.metadata");
  if (await columnExists(cx, "public", bare, "custom_data")) metaCandidates.push("l.custom_data");

  // Build a unified rawMetaExpr that coalesces follow-up date fields from all
  // present JSON columns and common key names. This produces a TEXT value (or NULL).
  let rawMetaExpr: string | null = null;
  if (metaCandidates.length > 0) {
    const keys = [
      "follow_up_date",
      "followup_date",
      "followUpDate",
      "followupDate",
      "next_followup",
      "reminder_at",
    ];
    const accessors: string[] = [];
    for (const col of metaCandidates) {
      for (const k of keys) {
        accessors.push(`${col} ->> '${k}'`);
      }
    }
    rawMetaExpr = `NULLIF(COALESCE(${accessors.join(", ")}), '')`;
  }

  // Helper: build the same COALESCE(...) meta accessor expression used in the SQL snippets
  function buildCoalesceMetaAccessors(availableCols: string[]) {
    const keys = ["follow_up_date", "followup_date", "followUpDate", "followupDate", "next_followup", "reminder_at"];
    const parts: string[] = [];
    for (const col of availableCols) {
      for (const k of keys) parts.push(`${col} ->> '${k}'`);
    }
    return parts.length ? `NULLIF(COALESCE(${parts.join(", ")}), '')` : null;
  }
  const coalesceExpr = buildCoalesceMetaAccessors(metaCandidates);

  const hasStatus = await columnExists(cx, "public", bare, "status");
  const hasStage = await columnExists(cx, "public", bare, "stage");
  const hasOwner = await columnExists(cx, "public", bare, "owner_id");
  const hasCreatedBy = await columnExists(cx, "public", bare, "created_by");
  const hasCompanyId = await columnExists(cx, "public", bare, "company_id");

  let directDateExpr: string | null = null;
  if (hasFollowUpDate) {
    directDateExpr = `l."follow_up_date"`;
  } else if (hasFollowupDate) {
    directDateExpr = `l."followup_date"`;
  }

  // base where and params
  let where = `l.tenant_id = $1::uuid`;
  const params: any[] = [tenantId];

  if (hasCompanyId && companyId) {
    where += ` AND l.company_id = $${params.length + 1}`;
    params.push(companyId);
  }

  // determine scope using tokens
  let mine = true;
  try {
    const tokens = await fetchUserRoleTokens(cx, tenantId, userId);
    const isAdmin = tokens.some(isAdminLikeToken) || tokens.some(isTenantAdminLikeToken);
    mine = !isAdmin;
  } catch (e) {
    mine = true;
  }

  // if mine, filter by owner or created_by if present
  if (mine) {
    if (hasOwner) {
      where += ` AND COALESCE(l.owner_id::text,'') = $${params.length + 1}::text`;
      params.push(String(userId));
    } else if (hasCreatedBy) {
      where += ` AND COALESCE(l.created_by::text,'') = $${params.length + 1}::text`;
      params.push(String(userId));
    }
  }

  let openPredicate = `true`;
  if (hasStatus) {
    openPredicate = `COALESCE(NULLIF(TRIM(lower(l.status)), ''), 'open') !~ '^(closed|closed[-_ ]?(won|lost))$'`;
  } else if (hasStage) {
    openPredicate = `COALESCE(NULLIF(TRIM(lower(l.stage)), ''), 'new') !~ '^(won|lost)$'`;
  } else if (rawMetaExpr) {
    const closeChecks: string[] = [];
    if (await columnExists(cx, "public", bare, "meta")) closeChecks.push(`(l.meta -> 'close') IS NULL`);
    if (await columnExists(cx, "public", bare, "metadata")) closeChecks.push(`(l.metadata -> 'close') IS NULL`);
    if (await columnExists(cx, "public", bare, "custom_data")) closeChecks.push(`(l.custom_data -> 'close') IS NULL`);
    if (closeChecks.length > 0) openPredicate = `(${closeChecks.join(" AND ")})`;
    else openPredicate = `true`;
  } else {
    openPredicate = `true`;
  }

  const todayTextExpr = `to_char((NOW() AT TIME ZONE '${IST}')::date, 'YYYY-MM-DD')`;

  // build fup_date_text (fallback path — kept for schemas that prefer direct column or earlier logic)
  let fupDateTextExpr: string;
  if (directDateExpr) {
    fupDateTextExpr = `(CASE WHEN (${directDateExpr}) IS NOT NULL THEN to_char((${directDateExpr})::date,'YYYY-MM-DD') ELSE NULL END)`;
  } else if (rawMetaExpr) {
    fupDateTextExpr = `(CASE
      WHEN (${rawMetaExpr}) IS NULL OR trim(${rawMetaExpr}) = '' THEN NULL
      WHEN (${rawMetaExpr}) ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN (${rawMetaExpr})
      WHEN (${rawMetaExpr}) ~ '^\\d{4}-\\d{2}-\\d{2}T' THEN to_char(((${rawMetaExpr})::timestamptz)::date,'YYYY-MM-DD')
      ELSE NULL
    END)`;
  } else {
    const explicitParts: string[] = [];
    if (await columnExists(cx, "public", bare, "meta")) {
      explicitParts.push(`l.meta ->> 'follow_up_date'`, `l.meta ->> 'followup_date'`);
    }
    if (await columnExists(cx, "public", bare, "metadata")) {
      explicitParts.push(`l.metadata ->> 'follow_up_date'`, `l.metadata ->> 'followup_date'`);
    }
    if (await columnExists(cx, "public", bare, "custom_data")) {
      explicitParts.push(`l.custom_data ->> 'follow_up_date'`, `l.custom_data ->> 'followup_date'`);
    }
    if (explicitParts.length > 0) {
      fupDateTextExpr = `NULLIF(COALESCE(${explicitParts.join(", ")}), '')`;
    } else {
      fupDateTextExpr = `NULL`;
    }
  }

  // ------------------ Tenant-wide today's followups (UNFILTERED) ------------------
  // If we have JSON meta columns, use the coalesceExpr approach; otherwise fall back to previous logic
  let todaysFollowupsAll = 0;
  try {
    if (coalesceExpr) {
      // params for the tenant-wide SQL: tenantId, IST, (optional companyId)
      const paramsAll: any[] = [tenantId, IST];
      let companyClause = "";
      if (hasCompanyId && companyId) {
        companyClause = ` AND l.company_id = $3`;
        paramsAll.push(companyId);
      }

      const sqlAll = `
        WITH vars AS (
          SELECT $1::uuid AS tenant_id,
                 to_char((NOW() AT TIME ZONE $2)::date,'YYYY-MM-DD') AS today_ist
        )
        SELECT COUNT(*)::int AS todays_followups_all
        FROM ${table} l, vars v
        WHERE l.tenant_id = v.tenant_id
          ${companyClause}
          AND (${coalesceExpr}) = v.today_ist;
      `;

      const allRes = await cx.query(sqlAll, paramsAll);
      todaysFollowupsAll = (allRes?.rows?.[0]?.todays_followups_all ?? 0);
    } else {
      // no JSON meta present: fallback (use direct fupDateTextExpr if available)
      if (fupDateTextExpr && fupDateTextExpr !== "NULL") {
        const tenantParams: any[] = [tenantId];
        let companyClause = "";
        if (hasCompanyId && companyId) {
          companyClause = ` AND l.company_id = $2`;
          tenantParams.push(companyId);
        }
        const sqlAllFallback = `
          WITH vars AS (
            SELECT $1::uuid AS tenant_id,
                   to_char((NOW() AT TIME ZONE $2)::date,'YYYY-MM-DD') AS today_ist
          )
          SELECT COUNT(*)::int AS todays_followups_all
          FROM ${table} l, vars v
          WHERE l.tenant_id = v.tenant_id
            ${companyClause}
            AND (${fupDateTextExpr}) = v.today_ist;
        `;
        const allRes = await cx.query(sqlAllFallback, [tenantId, IST, ...(hasCompanyId && companyId ? [companyId] : [])]);
        todaysFollowupsAll = (allRes?.rows?.[0]?.todays_followups_all ?? 0);
      } else {
        todaysFollowupsAll = 0;
      }
    }
  } catch (e) {
    console.error("Failed to compute tenant-wide todays followups:", e);
    todaysFollowupsAll = 0;
  }
  // -------------------------------------------------------------------------------

  // now compute scoped open leads + scoped today's followups (not used for dashboard but returned)
  const fallbackSql = `
    WITH base AS (
      SELECT l.id, ${fupDateTextExpr} AS fup_date_text
      FROM ${table} l
      WHERE ${where}
        AND (${openPredicate})
    )
    SELECT
      COUNT(*)::int AS open_leads,
      SUM(
        CASE WHEN fup_date_text IS NOT NULL AND fup_date_text = ${todayTextExpr} THEN 1 ELSE 0 END
      )::int AS todays_followups
    FROM base;
  `;

  let rows;
  try {
    if (coalesceExpr) {
      // scoped SQL using coalesceExpr and parameterized IST as last param
      const paramsScoped = [...params, IST]; // IST is used by $N in the SQL below
      const sqlScoped = `
        WITH base AS (
          SELECT l.id, (${coalesceExpr}) AS fup_date_text
          FROM ${table} l
          WHERE ${where}
            AND (${openPredicate})
        )
        SELECT
          COUNT(*)::int AS open_leads,
          SUM(
            CASE WHEN fup_date_text IS NOT NULL AND fup_date_text = to_char((NOW() AT TIME ZONE $${paramsScoped.length})::date,'YYYY-MM-DD') THEN 1 ELSE 0 END
          )::int AS todays_followups
        FROM base;
      `;
      const res = await cx.query(sqlScoped, paramsScoped);
      rows = res.rows;
    } else {
      // no coalesceExpr — use fallback sql (which references fupDateTextExpr already built)
      const res = await cx.query(fallbackSql, params);
      rows = res.rows;
    }
  } catch (err: any) {
    try {
      console.error("KPIS QUERY ERROR:", err);
      const posStr = err && err.position ? String(err.position) : null;
      const pos = posStr ? Math.max(0, parseInt(posStr, 10) - 1) : null;
      const compactSql = String(fallbackSql).replace(/\s+/g, " ").trim();
      console.error("[kpis SQL compact]", compactSql);
      console.error("[kpis PARAMS]", params);
      if (pos !== null && !Number.isNaN(pos)) {
        const ctxRadius = 80;
        const start = Math.max(0, pos - ctxRadius);
        const end = Math.min(compactSql.length, pos + ctxRadius);
        const before = compactSql.slice(start, pos);
        const atChar = compactSql.slice(pos, pos + 1);
        const after = compactSql.slice(pos + 1, end);
        console.error("---- SQL context (position " + pos + ", 0-based) ----");
        console.error((start === 0 ? "" : "...") + before + "<<< ERROR AT HERE <<<" + atChar + after + (end === compactSql.length ? "" : "..."));
        console.error("---- end context ----");
      } else {
        console.error("No err.position available from Postgres error. Full SQL printed above.");
      }
    } catch (logErr) {
      console.error("Failed to log SQL context:", logErr);
    }
    throw err;
  }

  const row = rows?.[0] ?? { open_leads: 0, todays_followups: 0 };

  // Return object — use tenant-wide count for dashboard's today followups as requested
  return {
    scope: mine ? "mine" : "all",
    open_leads_count: row.open_leads,
    open_leads: row.open_leads,
    // Dashboard: tenant-wide today's followups (unfiltered by owner/scope)
    todays_followups: todaysFollowupsAll,
    followups_today: todaysFollowupsAll,
    open_leads_trend: "+0%",
    tenant_count: tenantCount,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
   GET /kpis
──────────────────────────────────────────────────────────────────────────── */
router.get("/kpis", requireSession, async (req: any, res: any) => {
  const tenantId = req.session?.tenant_id;
  const userId = req.session?.user_id;
  const companyId = req.session?.company_id ?? null;

  if (!tenantId) return res.status(400).json({ error: "tenant_id_missing_in_session" });
  if (!userId) return res.status(400).json({ error: "user_id_missing_in_session" });

  const cx = await pool.connect();
  try {
    await cx.query(`SELECT set_config('app.tenant_id', $1::text, true)`, [String(tenantId)]);
    await cx.query(`SELECT set_config('app.user_id', $1::text, true)`, [String(userId)]);
    if (companyId) {
      await cx.query("SELECT set_config('app.company_id', $1::text, true)", [String(companyId)]);
    }

    const result = await computeKpis(cx, tenantId, userId, companyId, String(req.query.table ?? ""));
    console.log(`[kpis] tenant=${tenantId} user=${userId} result=${JSON.stringify(result)}`);
    return res.json(result);
  } catch (err) {
    console.error("KPIs error:", err);
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
    try {
      cx.release(true);
    } catch (e) {
      console.error("KPIs release error:", e);
    }
  }
});

/* ────────────────────────────────────────────────────────────────────────────
   SSE: GET /events/kpis  (Server-Sent Events)
──────────────────────────────────────────────────────────────────────────── */
router.get("/events/kpis", requireSession, async (req: any, res: any) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  if (typeof (res as any).flushHeaders === "function") (res as any).flushHeaders();

  const tenantId = req.session.tenant_id;
  const userId = req.session.user_id;
  const companyId = req.session.company_id ?? null;

  function sendEvent(eventName: string, data: any) {
    try {
      res.write(`event: ${eventName}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (e) {
      void e;
    }
  }

  // initial KPIs
  let cxInit: any = null;
  try {
    cxInit = await pool.connect();
    await cxInit.query("BEGIN");
    await cxInit.query(`SELECT set_config('app.tenant_id', $1::text, true)`, [String(tenantId)]);
    await cxInit.query(`SELECT set_config('app.user_id', $1::text, true)`, [String(userId)]);
    if (companyId) await cxInit.query("SELECT set_config('app.company_id', $1::text, true)", [String(companyId)]);
    const initial = await computeKpis(cxInit, tenantId, userId, companyId, String(req.query.table ?? ""));
    await cxInit.query("COMMIT");
    sendEvent("kpis", initial);
  } catch (e) {
    try {
      await cxInit?.query("ROLLBACK");
    } catch (e) {}
    sendEvent("error", { message: "initial_kpis_failed" });
  } finally {
    try {
      cxInit?.release(true);
    } catch (e) {}
  }

  const client = await pool.connect();
  let listening = false;

  const onNotification = async (msg: any) => {
    try {
      if (!msg || !msg.payload) return;
      let payload: any = null;
      try {
        payload = JSON.parse(msg.payload);
      } catch {
        payload = null;
      }
      if (payload && payload.tenant_id && String(payload.tenant_id) !== String(tenantId)) return;

      const cx2 = await pool.connect();
      try {
        await cx2.query("BEGIN");
        await cx2.query(`SELECT set_config('app.tenant_id', $1::text, true)`, [String(tenantId)]);
        await cx2.query(`SELECT set_config('app.user_id', $1::text, true)`, [String(userId)]);
        if (companyId) await cx2.query("SELECT set_config('app.company_id', $1::text, true)", [String(companyId)]);
        const k = await computeKpis(cx2, tenantId, userId, companyId, String(req.query.table ?? ""));
        await cx2.query("COMMIT");
        sendEvent("kpis", k);
      } catch (err) {
        try {
          await cx2.query("ROLLBACK");
        } catch {}
        sendEvent("error", { message: "compute_failed" });
      } finally {
        try {
          cx2.release(true);
        } catch {}
      }
    } catch (e) {
      console.error("SSE onNotification error:", e);
    }
  };

  try {
    await client.query("LISTEN leads_changed");
    client.on("notification", onNotification);
    listening = true;
  } catch (e) {
    console.error("SSE listen failed:", e);
    sendEvent("error", { message: "listen_failed" });
  }

  const keepAlive = setInterval(() => {
    try {
      res.write(": keep-alive\n\n");
    } catch (e) {
      void e;
    }
  }, 20000);

  req.on("close", async () => {
    clearInterval(keepAlive);
    try {
      if (listening) {
        client.removeListener("notification", onNotification);
        await client.query("UNLISTEN leads_changed");
      }
    } catch (e) {
      void e;
    }
    try {
      client.release(true);
    } catch (e) {
      void e;
    }
    try {
      res.end();
    } catch (e) {
      void e;
    }
  });
});

export default router;
