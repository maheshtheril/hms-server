// src/routes/company/dashboard.ts
import express from "express";
import { pool } from "../../db";
import requireSession from "../../middleware/requireSession";

const router = express.Router();

async function safeCount(client: any, sql: string, params: any[] = []) {
  try {
    const r = await client.query(sql, params);
    // allow returning sum/value as "count" or "sum"
    const val = r.rows?.[0];
    if (!val) return null;
    const first = Object.values(val)[0];
    return typeof first === "string" ? Number(first) : first;
  } catch (err) {
    return null;
  }
}

async function tryQuery(client: any, sql: string, params: any[] = []) {
  try {
    const r = await client.query(sql, params);
    return r.rows?.[0] ?? null;
  } catch (err) {
    return null;
  }
}

/**
 * GET /api/company/dashboard
 * Uses session.active_company_id OR query param company_id as fallback.
 */
router.get("/", requireSession, async (req: any, res) => {
  const session = req.session ?? {};
  let companyId = session.active_company_id || req.query.company_id || null;
  const tenantId = session.tenant_id;
  if (!tenantId) return res.status(401).json({ error: "not_authenticated" });
  if (!companyId) {
    // fallback: if tenant.default_company_id exists, use it
    const clientTmp = await pool.connect();
    try {
      const t = await tryQuery(clientTmp, `SELECT default_company_id FROM public.tenant WHERE id = $1`, [tenantId]);
      companyId = t?.default_company_id ?? null;
    } finally {
      clientTmp.release();
    }
  }

  if (!companyId) return res.status(400).json({ error: "missing_company" });

  const client = await pool.connect();
  try {
    // validate company belongs to tenant
    const comp = await tryQuery(client, `SELECT id, name, industry, metadata FROM public.company WHERE id = $1 AND tenant_id = $2 LIMIT 1`, [companyId, tenantId]);
    if (!comp) return res.status(404).json({ error: "company_not_found" });

    // Basic company info
    const companyInfo = comp;

    // KPIs: Attempt to collect healthcare + finance + crm + inventory basics
    const metrics: any = {};

    // Beds / wards
    const totalBeds = await safeCount(client, `SELECT count(*)::int FROM public.hms_bed WHERE company_id = $1`, [companyId]);
    const occupiedBeds = await safeCount(client, `SELECT count(*)::int FROM public.hms_bed WHERE company_id = $1 AND status IN ('occupied','allocated','in_use')`, [companyId]);
    metrics.total_beds = totalBeds;
    metrics.occupied_beds = occupiedBeds;

    // Admissions / OPD / Surgeries
    const admissionsToday =
      (await safeCount(client, `SELECT count(*)::int FROM public.hms_admission WHERE company_id = $1 AND date(created_at)=current_date`, [companyId])) ??
      (await safeCount(client, `SELECT count(*)::int FROM public.hms_admissions WHERE company_id = $1 AND date(created_at)=current_date`, [companyId]));
    const opdToday =
      (await safeCount(client, `SELECT count(*)::int FROM public.hms_appointments WHERE company_id = $1 AND date(start_at)=current_date`, [companyId])) ??
      (await safeCount(client, `SELECT count(*)::int FROM public.hms_encounters WHERE company_id = $1 AND date(created_at)=current_date`, [companyId]));
    const surgeriesToday =
      (await safeCount(client, `SELECT count(*)::int FROM public.hms_procedures WHERE company_id = $1 AND date(scheduled_at)=current_date`, [companyId])) ??
      0;
    metrics.admissions_today = admissionsToday;
    metrics.opd_today = opdToday;
    metrics.surgeries_today = surgeriesToday;

    // Lab
    const pendingLab =
      (await safeCount(client, `SELECT count(*)::int FROM public.hms_lab_results WHERE company_id = $1 AND status IN ('pending','requested')`, [companyId])) ??
      (await safeCount(client, `SELECT count(*)::int FROM public.hms_lab_orders WHERE company_id = $1 AND status IN ('pending','collected')`, [companyId])) ??
      0;
    metrics.pending_lab = pendingLab;

    // Imaging
    const pendingImaging =
      (await safeCount(client, `SELECT count(*)::int FROM public.hms_imaging_orders WHERE company_id = $1 AND status IN ('pending','scheduled')`, [companyId])) ??
      0;
    metrics.pending_imaging = pendingImaging;

    // Pharmacy / stock shortages
    const pharmacyShort =
      (await safeCount(client, `SELECT count(*)::int FROM public.hms_stock WHERE company_id = $1 AND (qty_available <= reorder_level OR qty_available <= 0)`, [companyId])) ??
      0;
    metrics.pharmacy_shortages = pharmacyShort;

    // Active patients
    const activePatients =
      (await safeCount(client, `SELECT count(*)::int FROM public.hms_patient WHERE company_id = $1 AND (is_active IS DISTINCT FROM false)`, [companyId])) ??
      (await safeCount(client, `SELECT count(*)::int FROM public.hms_patients WHERE company_id = $1`, [companyId])) ??
      0;
    metrics.active_patients = activePatients;

    // Finance: revenue last 30 days (attempt invoices)
    const revenue30d =
      (await safeCount(client, `SELECT COALESCE(SUM(total_amount)::bigint,0) FROM public.invoices WHERE company_id = $1 AND created_at >= now() - interval '30 days'`, [companyId])) ??
      (await safeCount(client, `SELECT COALESCE(SUM(amount)::bigint,0) FROM public.hms_invoices WHERE company_id = $1 AND created_at >= now() - interval '30 days'`, [companyId])) ??
      0;
    metrics.revenue_30d = revenue30d;

    // CRM: leads (basic)
    const leadsCount =
      (await safeCount(client, `SELECT count(*)::int FROM public.lead WHERE company_id = $1`, [companyId])) ??
      (await safeCount(client, `SELECT count(*)::int FROM public.leads WHERE company_id = $1`, [companyId])) ??
      0;
    metrics.leads = leadsCount;

    // Inventory value (best effort)
    const stockValue =
      (await safeCount(client, `SELECT COALESCE(SUM(qty_available*unit_cost)::bigint,0) FROM public.hms_stock WHERE company_id = $1`, [companyId])) ??
      null;
    metrics.stock_value = stockValue;

    // Alerts & AI placeholder
    const alerts: any[] = [];
    if ((metrics.pharmacy_shortages ?? 0) > 0) {
      alerts.push({ type: "stock", message: `${metrics.pharmacy_shortages} items below reorder level` });
    }
    if ((metrics.pending_lab ?? 0) > 50) {
      alerts.push({ type: "lab", message: `High lab backlog (${metrics.pending_lab})` });
    }

    const ai_insights = [
      `Occupancy is ${(metrics.occupied_beds && metrics.total_beds) ? `${Math.round((metrics.occupied_beds / Math.max(metrics.total_beds,1)) * 100)}%` : "N/A"}`,
    ];

    return res.json({
      company: companyInfo,
      metrics,
      alerts,
      ai_insights,
    });
  } catch (err: any) {
    console.error("company/dashboard error", err);
    return res.status(500).json({ error: "internal_server_error", message: "failed to build company dashboard" });
  } finally {
    client.release();
  }
});

export default router;
