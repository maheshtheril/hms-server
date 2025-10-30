"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.activitiesRouter = void 0;
// server/routes/activities.ts
const express_1 = __importDefault(require("express"));
const pg_1 = require("pg");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
exports.activitiesRouter = express_1.default.Router();
/**
 * Production-ready activities endpoint using public.lead.
 *
 * Auth sources: req.user || req.session.userId || Authorization: Bearer <JWT>
 * Ownership filter: owner_id OR created_by matches user id
 *
 * Query params:
 *  - for = today | upcoming | past (default: today)
 *  - limit = number (default: 6, max: 200)
 *
 * Response:
 *  { ok: true, activities: [ { id, name, primary_email, primary_phone, owner_id, created_at, updated_at, status, stage, priority, estimated_value, follow_up_date } ] }
 */
// Get or create pg Pool
function getPool(app) {
    if (app?.locals?.db)
        return app.locals.db;
    if (process.env.DATABASE_URL) {
        return new pg_1.Pool({ connectionString: process.env.DATABASE_URL });
    }
    return null;
}
// Resolve user id from common auth mechanisms
async function resolveUserId(req) {
    const anyReq = req;
    if (anyReq.user && (anyReq.user.id || anyReq.user.userId)) {
        return String(anyReq.user.id ?? anyReq.user.userId);
    }
    if (anyReq.session && anyReq.session.userId) {
        return String(anyReq.session.userId);
    }
    const auth = (req.headers.authorization || req.headers.Authorization);
    if (auth && auth.startsWith("Bearer ")) {
        const token = auth.slice(7).trim();
        try {
            const secret = process.env.JWT_SECRET;
            if (!secret) {
                console.warn("JWT_SECRET not set — cannot verify JWT");
                return null;
            }
            const payload = jsonwebtoken_1.default.verify(token, secret);
            const sub = payload.sub ?? payload.userId ?? payload.id ?? null;
            if (sub)
                return String(sub);
        }
        catch (err) {
            console.warn("JWT verify failed:", err?.message ?? err);
            return null;
        }
    }
    return null;
}
exports.activitiesRouter.get("/", async (req, res) => {
    const pool = getPool(req.app);
    if (!pool) {
        console.error("GET /api/activities - no DB pool found (set app.locals.db or DATABASE_URL)");
        return res.status(500).json({ ok: false, error: "db_not_configured" });
    }
    try {
        const userId = await resolveUserId(req);
        if (!userId) {
            return res.status(401).json({ ok: false, error: "unauthorized" });
        }
        // params
        const period = String(req.query.for ?? "today").toLowerCase();
        const rawLimit = Number(req.query.limit ?? 6);
        const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, Math.floor(rawLimit)), 200) : 6;
        /*
          Strategy:
          - follow_up_date is stored inside custom_data JSONB or maybe metadata JSONB.
          - Use COALESCE(custom_data->>'follow_up_date', metadata->>'follow_up_date') as follow_up_date_text
          - Try to parse it as timestamp with timezone in SQL (to_timestamp or casting).
          - If follow_up_date is missing, fallback to created_at for "today" filter only.
        */
        // Build WHERE clause pieces
        const whereClauses = [];
        const params = [];
        // Ownership filter: owner_id OR created_by equals userId
        params.push(userId);
        whereClauses.push(`(owner_id = $${params.length} OR created_by = $${params.length})`);
        // Period filters
        // We'll compute follow_up_date_ts as: (custom_data->>'follow_up_date')::timestamptz if present
        // Use strict SQL to avoid SQL injection (no interpolation of user values)
        if (period === "today") {
            // Leads where follow_up_date is today (server timezone) OR created_at is today when follow_up_date missing
            whereClauses.push(`(
        (
          (custom_data->>'follow_up_date') IS NOT NULL
          AND (custom_data->>'follow_up_date')::timestamptz >= date_trunc('day', now())
          AND (custom_data->>'follow_up_date')::timestamptz < date_trunc('day', now()) + interval '1 day'
        )
        OR
        (
          (custom_data->>'follow_up_date') IS NULL
          AND created_at >= date_trunc('day', now())
          AND created_at < date_trunc('day', now()) + interval '1 day'
        )
      )`);
        }
        else if (period === "upcoming") {
            whereClauses.push(`
        (
          (custom_data->>'follow_up_date') IS NOT NULL
          AND (custom_data->>'follow_up_date')::timestamptz >= now()
        )
      `);
        }
        else if (period === "past") {
            whereClauses.push(`
        (
          (custom_data->>'follow_up_date') IS NOT NULL
          AND (custom_data->>'follow_up_date')::timestamptz < now()
        )
      `);
        } // else no date filter
        // Exclude soft-deleted if custom_data or metadata contains deleted_at (common pattern)
        // If your app uses a "deleted_at" column, adjust accordingly; this is safe fallback
        whereClauses.push(`( (custom_data->>'deleted_at') IS NULL AND (metadata->>'deleted_at') IS NULL )`);
        // Compose final SQL
        // Select useful fields from lead table according to your schema
        const sql = `
      SELECT
        id,
        tenant_id,
        company_id,
        owner_id,
        created_by,
        name,
        primary_email,
        primary_phone,
        status,
        stage,
        priority,
        estimated_value,
        created_at,
        updated_at,
        custom_data,
        metadata,
        COALESCE(NULLIF(custom_data->>'follow_up_date', ''), NULLIF(metadata->>'follow_up_date', '')) AS follow_up_date_text
      FROM public.lead
      WHERE ${whereClauses.join(" AND ")}
      ORDER BY
        -- Prefer follow_up_date if present, otherwise created_at
        (CASE WHEN (COALESCE(NULLIF(custom_data->>'follow_up_date', ''), NULLIF(metadata->>'follow_up_date','')) IS NOT NULL)
          THEN (COALESCE(NULLIF(custom_data->>'follow_up_date', ''), NULLIF(metadata->>'follow_up_date',''))::timestamptz)
          ELSE created_at END) ASC NULLS LAST,
        created_at DESC
      LIMIT $${params.length + 1}
    `;
        params.push(limit);
        const result = await pool.query(sql, params);
        const activities = result.rows.map((r) => {
            // parse follow_up_date_text to ISO if present
            let follow_up_date = null;
            try {
                if (r.follow_up_date_text) {
                    // let Postgres text already parseable as timestamptz; but ensure string ISO
                    follow_up_date = new Date(r.follow_up_date_text).toISOString();
                }
            }
            catch {
                follow_up_date = null;
            }
            return {
                id: r.id,
                tenant_id: r.tenant_id,
                company_id: r.company_id,
                owner_id: r.owner_id,
                created_by: r.created_by,
                name: r.name,
                primary_email: r.primary_email,
                primary_phone: r.primary_phone,
                status: r.status,
                stage: r.stage,
                priority: r.priority,
                estimated_value: r.estimated_value,
                created_at: r.created_at,
                updated_at: r.updated_at,
                follow_up_date,
                custom_data: r.custom_data,
                metadata: r.metadata,
            };
        });
        return res.status(200).json({ ok: true, activities });
    }
    catch (err) {
        console.error("GET /api/activities (lead) failed:", err?.stack ?? err);
        return res.status(500).json({ ok: false, error: "server_error" });
    }
});
