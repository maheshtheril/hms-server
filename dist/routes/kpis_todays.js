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
const db_1 = require("../db");
const cookie = __importStar(require("cookie"));
const sessionService_1 = require("../services/sessionService");
const router = (0, express_1.Router)();
/*─────────────────────────────────────────────
  Reuse requireSession (simplified local copy)
─────────────────────────────────────────────*/
async function requireSession(req, res, next) {
    try {
        const cookies = cookie.parse(req.headers.cookie || "");
        const sid = cookies.sid || cookies.ssr_sid;
        if (!sid)
            return res.status(401).json({ error: "unauthenticated" });
        const sess = await (0, sessionService_1.findSessionBySid)(sid);
        if (!sess)
            return res.status(401).json({ error: "invalid_session" });
        const headerCompany = req.headers["x-company-id"]?.trim();
        const cookieCompany = cookies.cid?.trim();
        req.session = {
            sid: sess.sid,
            user_id: sess.user_id,
            tenant_id: sess.tenant_id,
            company_id: headerCompany || cookieCompany || sess.company_id || null,
        };
        (0, sessionService_1.touchSession)(sid).catch((err) => console.error("touchSession error:", err));
        next();
    }
    catch (e) {
        console.error("requireSession failed:", e);
        return res.status(500).json({ error: "session_failed" });
    }
}
/*─────────────────────────────────────────────
  GET /kpis/todays → tenant-wide follow-up count
─────────────────────────────────────────────*/
router.get("/kpis/todays", requireSession, async (req, res) => {
    const tenantId = req.session?.tenant_id || String(req.query.tenantId || "");
    if (!tenantId)
        return res.status(400).json({ error: "tenant_id_required" });
    const cx = await db_1.pool.connect();
    try {
        // detect table name (lead or leads)
        const tableCheck = await cx.query(`SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND table_name IN ('lead','leads') LIMIT 1`);
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
    }
    catch (err) {
        console.error("GET /kpis/todays error:", err);
        return res.status(500).json({ error: "internal" });
    }
    finally {
        try {
            cx.release(true);
        }
        catch (e) {
            console.error("release error:", e);
        }
    }
});
// Temporary debug route — REMOVE THIS AFTER DEBUGGING
router.get("/kpis/todays/debug", async (req, res) => {
    const tenantId = String(req.query?.tenantId || "");
    if (!tenantId)
        return res.status(400).json({ error: "tenantId required" });
    const cx = await db_1.pool.connect();
    try {
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
        FROM public.lead l
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
    }
    catch (err) {
        console.error("GET /kpis/todays/debug error:", err);
        return res.status(500).json({ error: "internal" });
    }
    finally {
        try {
            cx.release(true);
        }
        catch { }
    }
});
exports.default = router;
