// server/src/routes/kpis.ts
import { Router } from "express";
import * as cookie from "cookie";
import { pool } from "../db";
import { findSessionBySid, touchSession } from "../services/sessionService";

const router = Router();

async function requireSession(req: any, res: any, next: any) {
  try {
    const cookies = cookie.parse(req.headers.cookie || "");
    const sid = cookies.sid || cookies.ssr_sid;
    if (!sid) return res.status(401).json({ error: "unauthenticated" });

    const sess = await findSessionBySid(sid);
    if (!sess) return res.status(401).json({ error: "invalid_session" });

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
  } catch {}

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
  } catch {}

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
  return /(admin|owner|administrator|sys\s*admin|sysadmin|root)/i.test(s) || /^admin(\.|:|_)/i.test(s);
}
function isTenantAdminLikeToken(s: string) {
  return /(tenant[_\s-]*admin|company[_\s-]*admin|manager)/i.test(s);
}

/**
 * computeKpis
 * - Reusable function that computes KPI object for given tenant/user/company
 * - Returns same shape as /kpis route JSON
 */
async function computeKpis(
  cx: any,
  tenantId: string,
  userId: string,
  companyId: string | null,
  tableOverride?: string
) {
  const IST = IST_TZ;

  // determine which table exists
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

  const sanityQ = await cx.query(`SELECT COUNT(*)::int AS c FROM ${table} l WHERE l.tenant_id = $1`, [tenantId]);
  const tenantCount = sanityQ?.rows?.[0]?.c ?? 0;

  const hasFollowUpDate = await columnExists(cx, "public", bare, "follow_up_date");
  const hasFollowupDate = !hasFollowUpDate && (await columnExists(cx, "public", bare, "followup_date"));

  // detect which meta-like column exists (meta, metadata, custom_data)
  let metaCol: string | null = null;
  if (await columnExists(cx, "public", bare, "meta")) metaCol = "meta";
  else if (await columnExists(cx, "public", bare, "metadata")) metaCol = "metadata";
  else if (await columnExists(cx, "public", bare, "custom_data")) metaCol = "custom_data";

  const hasStatus = await columnExists(cx, "public", bare, "status");
  const hasStage = await columnExists(cx, "public", bare, "stage");
  const hasOwner = await columnExists(cx, "public", bare, "owner_id");
  const hasCreatedBy = await columnExists(cx, "public", bare, "created_by");
  const hasCompanyId = await columnExists(cx, "public", bare, "company_id");

  // Build follow-up extraction pieces:
  // - directDateExpr: date value from direct column (if present)
  // - rawMetaExpr: raw text extracted from meta (if present)
  let directDateExpr: string | null = null;
  let rawMetaExpr: string | null = null;

  if (hasFollowUpDate) {
    directDateExpr = `l."follow_up_date"`;
  } else if (hasFollowupDate) {
    directDateExpr = `l."followup_date"`;
  } else if (metaCol) {
    rawMetaExpr = `NULLIF(COALESCE(
        l.${metaCol} ->> 'follow_up_date',
        l.${metaCol} ->> 'followup_date',
        l.${metaCol} ->> 'followUpDate',
        l.${metaCol} ->> 'followupDate',
        ''
      ), '')`;
  }

  let where = `l.tenant_id = $1`;
  const params: any[] = [tenantId];

  if (hasCompanyId && companyId) {
    where += ` AND l.company_id = $${params.length + 1}`;
    params.push(companyId);
  }

  // determine scope (mine/all) using roles
  let mine = true;
  try {
    const tokens = await fetchUserRoleTokens(cx, tenantId, userId);
    const isAdmin = tokens.some(isAdminLikeToken) || tokens.some(isTenantAdminLikeToken);
    mine = !isAdmin;
  } catch (e) {
    mine = true;
  }

  // Ownership filter: prefer owner_id, then created_by, otherwise no per-user filter
  if (mine) {
    if (hasOwner) {
      where += ` AND COALESCE(l.owner_id::text,'') = $${params.length + 1}::text`;
      params.push(String(userId));
    } else if (hasCreatedBy) {
      where += ` AND COALESCE(l.created_by::text,'') = $${params.length + 1}::text`;
      params.push(String(userId));
    }
  }

  // Build open/closed predicate — only reference columns that exist.
  let openPredicate = `true`;
  if (hasStatus) {
    openPredicate = `COALESCE(NULLIF(TRIM(lower(l.status)), ''), 'open') !~ '^(closed|closed[-_ ]?(won|lost))$'`;
  } else if (hasStage) {
    openPredicate = `COALESCE(NULLIF(TRIM(lower(l.stage)), ''), 'new') !~ '^(won|lost)$'`;
  } else if (metaCol) {
    openPredicate = `( (l.${metaCol} -> 'close') IS NULL )`;
  } else {
    openPredicate = `true`;
  }

  //
  // NEW approach: compute fup_date_text (YYYY-MM-DD) as TEXT for all branches,
  // then compare fup_date_text = today_text (both TEXT) to avoid text=date errors.
  //
  const todayTextExpr = `to_char((NOW() AT TIME ZONE '${IST}')::date, 'YYYY-MM-DD')`;

  // build fup_date_text expression:
  // - if directDateExpr exists: to_char(directDateExpr::date,'YYYY-MM-DD')
  // - else if rawMetaExpr matches YYYY-MM-DD -> use raw
  // - else if rawMetaExpr matches ISO datetime prefix -> cast to timestamptz then to_char(...,'YYYY-MM-DD')
  // - else NULL
  let fupDateTextExpr: string;
  if (directDateExpr) {
    // directDateExpr may be timestamp/date column — safe to cast to ::date then format
    fupDateTextExpr = `(CASE WHEN (${directDateExpr}) IS NOT NULL THEN to_char((${directDateExpr})::date,'YYYY-MM-DD') ELSE NULL END)`;
  } else if (rawMetaExpr) {
    fupDateTextExpr = `(CASE
      WHEN (${rawMetaExpr}) IS NULL OR trim(${rawMetaExpr}) = '' THEN NULL
      WHEN (${rawMetaExpr}) ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN (${rawMetaExpr})
      WHEN (${rawMetaExpr}) ~ '^\\d{4}-\\d{2}-\\d{2}T' THEN to_char(((${rawMetaExpr})::timestamptz)::date,'YYYY-MM-DD')
      ELSE NULL
    END)`;
  } else {
    fupDateTextExpr = `NULL`;
  }

  const sql = `
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

  // debug logging so we can inspect SQL / params when errors occur
  try {
    console.log("[kpis SQL]", sql.replace(/\s+/g, " ").trim());
    console.log("[kpis PARAMS]", params);
  } catch (e) {}

  // Run query with enhanced error logging that shows the SQL context at err.position
  let rows;
  try {
    const res = await cx.query(sql, params);
    rows = res.rows;
  } catch (err: any) {
    try {
      console.error("KPIS QUERY ERROR:", err);

      // Attempt to read position (Postgres returns it as a string 1-based)
      const posStr = err && err.position ? String(err.position) : null;
      const pos = posStr ? Math.max(0, parseInt(posStr, 10) - 1) : null;

      // Compact the SQL for one-line logging
      const compactSql = String(sql).replace(/\s+/g, " ").trim();

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
    // rethrow so outer try/catch still handles it and route returns error as before
    throw err;
  }

  const row = rows?.[0] ?? { open_leads: 0, todays_followups: 0 };

  return {
    scope: mine ? "mine" : "all",
    open_leads_count: row.open_leads,
    open_leads: row.open_leads,
    todays_followups: row.todays_followups,
    followups_today: row.todays_followups,
    open_leads_trend: "+0%",
    tenant_count: tenantCount,
  };
}

/**
 * GET /kpis
 */
router.get("/kpis", requireSession, async (req: any, res: any) => {
  const tenantId = req.session?.tenant_id;
  const userId = req.session?.user_id;
  const companyId = req.session?.company_id ?? null;

  if (!tenantId) return res.status(400).json({ error: "tenant_id_missing_in_session" });
  if (!userId) return res.status(400).json({ error: "user_id_missing_in_session" });

  const cx = await pool.connect();
  try {
    // avoid a long transaction here
    await cx.query(`SELECT set_config('app.tenant_id', $1::text, true)`, [String(tenantId)]);
    await cx.query(`SELECT set_config('app.user_id', $1::text, true)`, [String(userId)]);
    if (companyId) {
      await cx.query(`SELECT set_config('app.company_id', $1::text, true)`, [String(companyId)]);
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

/**
 * SSE: GET /events/kpis
 */
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
    } catch (e) {}
  }

  // initial KPIs
  let cxInit: any = null;
  try {
    cxInit = await pool.connect();
    await cxInit.query("BEGIN");
    await cxInit.query(`SELECT set_config('app.tenant_id', $1::text, true)`, [String(tenantId)]);
    await cxInit.query(`SELECT set_config('app.user_id', $1::text, true)`, [String(userId)]);
    if (companyId) await cxInit.query(`SELECT set_config('app.company_id', $1::text, true)`, [String(companyId)]);
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
        if (companyId) await cx2.query(`SELECT set_config('app.company_id', $1::text, true)`, [String(companyId)]);
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
    } catch (e) {}
  }, 20000);

  req.on("close", async () => {
    clearInterval(keepAlive);
    try {
      if (listening) {
        client.removeListener("notification", onNotification);
        await client.query("UNLISTEN leads_changed");
      }
    } catch (e) {}
    try {
      client.release(true);
    } catch (e) {}
    try {
      res.end();
    } catch (e) {}
  });
});

export default router;
