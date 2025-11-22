// server/src/industries/hospital/provisioning.ts
/**
 * Hospital / Healthcare provisioner
 * Creates departments, default roles, HMS settings, product categories, sample taxes/accounts and minimal templates.
 *
 * Expected payload shape (optional):
 * {
 *   subIndustry?: "clinic" | "hospital" | "lab",
 *   departments?: string[],
 *   billingMode?: "cash" | "insurance" | "mixed",
 *   countryId?: string,
 *   timezone?: string
 * }
 */

import { pool } from "../../db";

export async function provision(tenantId: string, companyId: string, userId: string, payload: any = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const subIndustry = payload.subIndustry || "hospital";
    const departments: string[] = Array.isArray(payload.departments) && payload.departments.length ? payload.departments : [
      "Outpatient", "Inpatient", "Emergency", "Pharmacy", "Laboratory", "Radiology", "ICU"
    ];
    const billingMode = payload.billingMode || "mixed"; // cash/insurance/mixed

    // 1) company_settings: mark hms flags
    await client.query(
      `INSERT INTO company_settings (company_id, hms_sub_industry, hms_billing_mode, updated_at)
       VALUES ($1,$2,$3,now())
       ON CONFLICT (company_id) DO UPDATE
         SET hms_sub_industry=EXCLUDED.hms_sub_industry,
             hms_billing_mode=EXCLUDED.hms_billing_mode,
             updated_at=now()`,
      [companyId, subIndustry, billingMode]
    );

    // 2) Departments
    for (const name of departments) {
      await client.query(
        `INSERT INTO hms_department (id, tenant_id, company_id, name, is_active, created_by)
         VALUES (gen_random_uuid(), $1, $2, $3, true, $4)
         ON CONFLICT (company_id, name) DO NOTHING`,
        [tenantId, companyId, name, userId]
      );
    }

    // 3) HMS settings table (billing)
    await client.query(
      `INSERT INTO hms_settings (company_id, billing_mode, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (company_id) DO UPDATE SET billing_mode = EXCLUDED.billing_mode, updated_at=now()`,
      [companyId, billingMode]
    );

    // 4) Product categories for pharmacy/consumables
    await client.query(
      `INSERT INTO product_category (id, tenant_id, company_id, name, is_active)
       VALUES (gen_random_uuid(), $1, $2, 'Medicines', true)
       ON CONFLICT (company_id, name) DO NOTHING`,
      [tenantId, companyId]
    );
    await client.query(
      `INSERT INTO product_category (id, tenant_id, company_id, name, is_active)
       VALUES (gen_random_uuid(), $1, $2, 'Consumables', true)
       ON CONFLICT (company_id, name) DO NOTHING`,
      [tenantId, companyId]
    );

    // 5) Lab test groups
    const labGroups = ["Blood Tests", "Urine Tests", "Imaging Reports"];
    for (const name of labGroups) {
      await client.query(
        `INSERT INTO lab_test_group (id, tenant_id, company_id, name, is_active)
         VALUES (gen_random_uuid(), $1, $2, $3, true)
         ON CONFLICT (company_id, name) DO NOTHING`,
        [tenantId, companyId, name]
      );
    }

    // 6) Doctor roles
    const doctorRoles = ["Consultant", "Surgeon", "Resident Doctor", "Nurse"];
    for (const role of doctorRoles) {
      await client.query(
        `INSERT INTO hms_doctor_role (id, tenant_id, company_id, name)
         VALUES (gen_random_uuid(), $1, $2, $3)
         ON CONFLICT (company_id, name) DO NOTHING`,
        [tenantId, companyId, role]
      );
    }

    // 7) Default ward & single bed for hospitals
    if (subIndustry === "hospital") {
      await client.query(
        `INSERT INTO hms_ward (id, tenant_id, company_id, name, is_active)
         VALUES (gen_random_uuid(), $1, $2, 'General Ward', true)
         ON CONFLICT (company_id, name) DO NOTHING`,
        [tenantId, companyId]
      );

      await client.query(
        `INSERT INTO hms_bed (id, tenant_id, company_id, ward_id, bed_no, status)
         SELECT gen_random_uuid(), $1, $2, w.id, '1', 'available'
         FROM hms_ward w
         WHERE w.company_id = $2 AND w.name = 'General Ward'
         LIMIT 1`,
        [tenantId, companyId]
      );
    }

    // 8) Seed minimal accounts & tax templates (if you have account tables)
    // NOTE: adapt table names/columns to exactly match your schema if different.
    await client.query(
      `INSERT INTO account_chart (id, tenant_id, company_id, code, name, type, is_active)
       VALUES (gen_random_uuid(), $1, $2, '4000', 'Hospital Revenue', 'revenue', true)
       ON CONFLICT (company_id, code) DO NOTHING`,
      [tenantId, companyId]
    );

    await client.query(
      `INSERT INTO tax_template (id, tenant_id, company_id, name, rate)
       VALUES (gen_random_uuid(), $1, $2, 'GST (default hospital)', 0.0)
       ON CONFLICT (company_id, name) DO NOTHING`,
      [tenantId, companyId]
    );

    // 9) Mark provisioned metadata
    await client.query(
      `INSERT INTO provisioned_industries (id, tenant_id, company_id, industry_key, payload, provisioned_at)
       VALUES (gen_random_uuid(), $1, $2, 'hospital', $3, now())
       ON CONFLICT (company_id, industry_key) DO UPDATE SET payload = EXCLUDED.payload, provisioned_at = now()`,
      [tenantId, companyId, JSON.stringify({ subIndustry, departments, billingMode })]
    );

    await client.query("COMMIT");
    console.log(`[hospital.provisioning] completed for company ${companyId}`);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[hospital.provisioning] error:", err);
    throw err;
  } finally {
    client.release();
  }
}

export default provision;
