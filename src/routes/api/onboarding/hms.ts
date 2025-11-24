import { pool } from "../../../db";
import { getSession } from "../../../lib/session";

/**
 * POST /api/onboarding/hms
 * Body expected: { subIndustry?: string, departments?: string[], billingMode: string }
 *
 * Notes:
 * - subIndustry is now optional (defaults to "hospital")
 * - departments coerced to array
 * - improved logging for easier debugging
 */
export async function hmsOnboardingHandler(req, res) {
  try {
    // accept both JSON body shapes safely
    const body = req.body || {};
    const subIndustry = (body.subIndustry || "hospital").toString();
    const departments = Array.isArray(body.departments) ? body.departments : [];
    const billingMode = body.billingMode ? String(body.billingMode) : "";

    if (!billingMode) {
      return res.status(400).json({ error: "missing_fields", message: "billingMode is required" });
    }

    const sid = req.cookies?.erp_session;
    const session = sid ? await getSession(sid) : null;

    if (!session || !session.user_id || !session.company_id) {
      return res.status(401).json({ error: "not_authenticated" });
    }

    const tenantId = session.tenant_id;
    const companyId = session.company_id;
    const userId = session.user_id;

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      /* ===============================
         Save onboarding data (company_settings)
         =============================== */
      await client.query(
        `UPDATE company_settings
         SET hms_sub_industry = $1,
             hms_departments = $2,
             hms_billing_mode = $3,
             updated_at = now()
         WHERE company_id = $4`,
        [ subIndustry, JSON.stringify(departments || []), billingMode, companyId ]
      );

      /* ===============================
         Provision HMS (direct, no worker!)
         =============================== */

      // Departments
      for (const dep of departments || []) {
        // ensure non-empty name
        const name = (dep || "").toString().trim();
        if (!name) continue;

        await client.query(
          `INSERT INTO hms_department
            (id, tenant_id, company_id, name, is_active, created_by)
           VALUES (gen_random_uuid(), $1, $2, $3, true, $4)
           ON CONFLICT (company_id, name) DO NOTHING`,
          [tenantId, companyId, name, userId]
        );
      }

      // HMS Settings (billing)
      await client.query(
        `INSERT INTO hms_settings
          (company_id, billing_mode)
         VALUES ($1, $2)
         ON CONFLICT (company_id)
         DO UPDATE SET billing_mode = EXCLUDED.billing_mode`,
        [companyId, billingMode]
      );

      // Pharmacy Categories
      await client.query(
        `INSERT INTO product_category
          (id, tenant_id, company_id, name)
         VALUES (gen_random_uuid(), $1, $2, 'Medicines')
         ON CONFLICT (company_id, name) DO NOTHING`,
        [tenantId, companyId]
      );

      await client.query(
        `INSERT INTO product_category
          (id, tenant_id, company_id, name)
         VALUES (gen_random_uuid(), $1, $2, 'Consumables')
         ON CONFLICT (company_id, name) DO NOTHING`,
        [tenantId, companyId]
      );

      // Basic Lab Groups
      const labGroups = ["Blood Tests", "Urine Tests", "Imaging Reports"];
      for (const lg of labGroups) {
        await client.query(
          `INSERT INTO lab_test_group
            (id, tenant_id, company_id, name)
           VALUES (gen_random_uuid(), $1, $2, $3)
           ON CONFLICT (company_id, name) DO NOTHING`,
          [tenantId, companyId, lg]
        );
      }

      // Default Ward & Bed (hospital only)
      if (subIndustry === "hospital") {
        await client.query(
          `INSERT INTO hms_ward
            (id, tenant_id, company_id, name)
           VALUES (gen_random_uuid(), $1, $2, 'General Ward')
           ON CONFLICT (company_id, name) DO NOTHING`,
          [tenantId, companyId]
        );

        await client.query(
          `INSERT INTO hms_bed
            (id, tenant_id, company_id, ward_id, bed_no, status)
           SELECT gen_random_uuid(), $1, $2, w.id, '1', 'available'
           FROM hms_ward w
           WHERE w.company_id = $2 AND w.name = 'General Ward'
           LIMIT 1`,
          [tenantId, companyId]
        );
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("HMS onboarding error (db transaction):", err);
      return res.status(500).json({ error: "onboarding_failed" });
    } finally {
      client.release();
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("HMS onboarding server error:", err);
    return res.status(500).json({ error: "server_error" });
  }
}
