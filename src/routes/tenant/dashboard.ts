// src/routes/tenant/dashboard.ts
import express from "express";
import { pool } from "../../db";
import requireSession from "../../middleware/requireSession"; // FIXED: default export

const router = express.Router();

/**
 * Defensive helpers
 */
async function safeCount(client: any, sql: string, params: any[] = []) {
  try {
    const r = await client.query(sql, params);
    return Number(r.rows?.[0]?.count ?? 0);
  } catch {
    return null;
  }
}

async function tryQueryOne(client: any, sql: string, params: any[] = []) {
  try {
    const r = await client.query(sql, params);
    return r.rows?.[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * GET /api/tenant/dashboard
 */
router.get("/", requireSession, async (req: any, res) => {
  const tenantId = req.session?.tenant_id;
  if (!tenantId) return res.status(401).json({ error: "not_authenticated" });

  const client = await pool.connect();
  try {
    // 1) Tenant info
    const tenant = await tryQueryOne(
      client,
      `SELECT id, name, slug, billing_plan, metadata, created_at, domain, default_company_id
         FROM public.tenant
        WHERE id = $1
        LIMIT 1`,
      [tenantId]
    );

    // 2) Companies for tenant
    const companiesRes = await client.query(
      `SELECT id, name, industry, metadata, logo_url, created_at
         FROM public.company
        WHERE tenant_id = $1
        ORDER BY created_at ASC`,
      [tenantId]
    );
    const companies = companiesRes.rows ?? [];

    // 3) Derive tenant industry cluster
    const industryCounts: Record<string, number> = {};
    for (const c of companies) {
      const ic = String(c.industry ?? "unknown").toLowerCase();
      industryCounts[ic] = (industryCounts[ic] || 0) + 1;
    }

    const healthcare = new Set([
      "hospital",
      "healthcare",
      "clinic",
      "lab",
      "diagnostics",
      "pharmacy",
      "imaging",
      "radiology",
    ]);
    const retail = new Set(["retail", "supermarket", "store"]);
    const manufacturing = new Set(["manufacturing", "factory", "plant"]);
    const services = new Set(["services", "consulting", "agency"]);

    let tenantIndustry = "general";
    if (Object.keys(industryCounts).length === 0) {
      tenantIndustry = (tenant?.metadata?.industry ?? "general").toString();
    } else {
      const sorted = Object.entries(industryCounts).sort((a, b) => b[1] - a[1]);
      const top = sorted[0][0];

      if (healthcare.has(top)) tenantIndustry = "healthcare";
      else if (retail.has(top)) tenantIndustry = "retail";
      else if (manufacturing.has(top)) tenantIndustry = "manufacturing";
      else if (services.has(top)) tenantIndustry = "services";
      else tenantIndustry = top || "general";
    }

    // 4) Global aggregated KPIs
    const globalKPIs: any = {
      total_companies: companies.length,
      total_employees: 0,
      total_revenue_30d: 0,
      total_active_patients: 0,
      total_beds: 0,
      total_occupied_beds: 0,
      total_admissions_today: 0,
      total_opd_today: 0,
      total_surgeries_today: 0,
      pending_lab_reports: 0,
      pharmacy_shortages: 0,
    };

    const companiesWithMetrics = [];

    // 5) Per-company metrics
    for (const c of companies) {
      const metrics: any = {};

      const totalBeds = await safeCount(
        client,
        `SELECT count(*) FROM public.hms_bed WHERE company_id = $1`,
        [c.id]
      );
      const occupiedBeds = await safeCount(
        client,
        `SELECT count(*) FROM public.hms_bed
          WHERE company_id = $1 AND status IN ('occupied','allocated','in_use')`,
        [c.id]
      );

      const admissionsToday =
        (await safeCount(
          client,
          `SELECT count(*) FROM public.hms_admission
            WHERE company_id = $1 AND date(created_at)=current_date`,
          [c.id]
        )) ??
        (await safeCount(
          client,
          `SELECT count(*) FROM public.hms_admissions
            WHERE company_id = $1 AND date(created_at)=current_date`,
          [c.id]
        ));

      const opdToday =
        (await safeCount(
          client,
          `SELECT count(*) FROM public.hms_appointment
            WHERE company_id = $1 AND date(start_at)=current_date`,
          [c.id]
        )) ??
        (await safeCount(
          client,
          `SELECT count(*) FROM public.hms_encounter
            WHERE company_id = $1 AND date(created_at)=current_date`,
          [c.id]
        ));

      const surgeriesToday =
        (await safeCount(
          client,
          `SELECT count(*) FROM public.hms_procedure
            WHERE company_id = $1 AND date(scheduled_at)=current_date`,
          [c.id]
        )) ?? 0;

      const pendingLab =
        (await safeCount(
          client,
          `SELECT count(*) FROM public.hms_lab_result
            WHERE company_id = $1 AND status IN ('pending','requested')`,
          [c.id]
        )) ??
        (await safeCount(
          client,
          `SELECT count(*) FROM public.hms_lab_order
            WHERE company_id = $1 AND status IN ('pending','collected')`,
          [c.id]
        )) ??
        0;

      const pharmacyShort =
        (await safeCount(
          client,
          `SELECT count(*) FROM public.hms_stock
            WHERE company_id = $1 AND (qty_available <= reorder_level OR qty_available <= 0)`,
          [c.id]
        )) ?? 0;

      const activePatients =
        (await safeCount(
          client,
          `SELECT count(*) FROM public.hms_patient
            WHERE company_id = $1 AND (is_active IS DISTINCT FROM false)`,
          [c.id]
        )) ??
        (await safeCount(
          client,
          `SELECT count(*) FROM public.hms_patients WHERE company_id = $1`,
          [c.id]
        )) ??
        0;

      const revenue30d =
        (await safeCount(
          client,
          `SELECT COALESCE(SUM(total_amount),0)
             FROM public.invoice
             WHERE company_id = $1 AND created_at >= now() - interval '30 days'`,
          [c.id]
        )) ??
        (await safeCount(
          client,
          `SELECT COALESCE(SUM(amount),0)
             FROM public.hms_invoice
             WHERE company_id = $1 AND created_at >= now() - interval '30 days'`,
          [c.id]
        )) ??
        0;

      const employeeCount =
        (await safeCount(
          client,
          `SELECT count(*) FROM public.hr_employee WHERE company_id = $1`,
          [c.id]
        )) ??
        (await safeCount(
          client,
          `SELECT count(*) FROM public.employees WHERE company_id = $1`,
          [c.id]
        )) ??
        0;

      metrics.total_beds = totalBeds;
      metrics.occupied_beds = occupiedBeds;
      metrics.admissions_today = admissionsToday;
      metrics.opd_today = opdToday;
      metrics.surgeries_today = surgeriesToday;
      metrics.pending_lab = pendingLab;
      metrics.pharmacy_shortages = pharmacyShort;
      metrics.active_patients = activePatients;
      metrics.revenue_30d = revenue30d;
      metrics.employee_count = employeeCount;

      // accumulate into global
      globalKPIs.total_beds += totalBeds ?? 0;
      globalKPIs.total_occupied_beds += occupiedBeds ?? 0;
      globalKPIs.total_admissions_today += admissionsToday ?? 0;
      globalKPIs.total_opd_today += opdToday ?? 0;
      globalKPIs.total_surgeries_today += surgeriesToday ?? 0;
      globalKPIs.pending_lab_reports += pendingLab ?? 0;
      globalKPIs.pharmacy_shortages += pharmacyShort ?? 0;
      globalKPIs.total_active_patients += activePatients ?? 0;
      globalKPIs.total_revenue_30d += revenue30d ?? 0;
      globalKPIs.total_employees += employeeCount ?? 0;

      companiesWithMetrics.push({
        id: c.id,
        name: c.name,
        industry: c.industry,
        metrics,
      });
    }

    const alerts = [];

    const ai_insights = [
      `Predictive occupancy: ${
        globalKPIs.total_beds
          ? Math.round(
              (globalKPIs.total_occupied_beds / globalKPIs.total_beds) * 100
            ) + "%"
          : "N/A"
      }`,
    ];

    return res.json({
      tenant: tenant ?? null,
      derived_industry: tenantIndustry,
      global: globalKPIs,
      companies: companiesWithMetrics,
      alerts,
      ai_insights,
      debug: { company_count: companies.length, industry_counts: industryCounts },
    });
  } catch (err) {
    console.error("tenant/dashboard error", err);
    return res
      .status(500)
      .json({ error: "internal_server_error", message: "failed to build tenant dashboard" });
  } finally {
    client.release();
  }
});

export default router;
