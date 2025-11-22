// server/src/workers/provisioning/hmsProvisioningWorker.ts

import { pool } from "../../db";

/**
 * HMS Provisioning Worker
 * Handles requested provisioning when onboarding selects
 * a healthcare sub-industry.
 *
 * This worker is triggered by provisioning_queue:
 *  job_type = 'hms_onboarding'
 *  payload = { subIndustry, departments, billingMode }
 */

export async function runHMSProvisioning(job: any) {
  const { tenantId, companyId, userId } = job;
  const { subIndustry, departments, billingMode } = job.payload || {};

  const client = await pool.connect();

  try {
    console.log("[HMS Provisioning] starting for company:", companyId);
    await client.query("BEGIN");

    /* ==========================================================
       1. Create Departments
       ========================================================== */
    if (Array.isArray(departments) && departments.length > 0) {
      for (const depName of departments) {
        await client.query(
          `INSERT INTO hms_department
            (id, tenant_id, company_id, name, is_active, created_by)
           VALUES (gen_random_uuid(), $1, $2, $3, true, $4)
           ON CONFLICT (company_id, name) DO NOTHING`,
          [tenantId, companyId, depName, userId]
        );
      }
    }

    /* ==========================================================
       2. Billing Mode (cash / insurance / mixed)
       ========================================================== */
    await client.query(
      `INSERT INTO hms_settings
        (company_id, billing_mode, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (company_id)
       DO UPDATE SET billing_mode = EXCLUDED.billing_mode, updated_at = now()`,
      [companyId, billingMode]
    );

    /* ==========================================================
       3. Pharmacy Default Category
       ========================================================== */
    await client.query(
      `INSERT INTO product_category
        (id, tenant_id, company_id, name, is_active)
       VALUES (gen_random_uuid(), $1, $2, 'Medicines', true)
       ON CONFLICT (company_id, name) DO NOTHING`,
      [tenantId, companyId]
    );

    await client.query(
      `INSERT INTO product_category
        (id, tenant_id, company_id, name, is_active)
       VALUES (gen_random_uuid(), $1, $2, 'Consumables', true)
       ON CONFLICT (company_id, name) DO NOTHING`,
      [tenantId, companyId]
    );

    /* ==========================================================
       4. Lab Default Test Groups (minimal)
       ========================================================== */
    const labGroups = ["Blood Tests", "Urine Tests", "Imaging Reports"];

    for (const name of labGroups) {
      await client.query(
        `INSERT INTO lab_test_group
          (id, tenant_id, company_id, name, is_active)
         VALUES (gen_random_uuid(), $1, $2, $3, true)
         ON CONFLICT (company_id, name) DO NOTHING`,
        [tenantId, companyId, name]
      );
    }

    /* ==========================================================
       5. Doctor Role Seeds
       ========================================================== */
    const doctorRoles = ["Consultant", "Surgeon", "Visiting Doctor"];

    for (const role of doctorRoles) {
      await client.query(
        `INSERT INTO hms_doctor_role
          (id, tenant_id, company_id, name)
         VALUES (gen_random_uuid(), $1, $2, $3)
         ON CONFLICT (company_id, name) DO NOTHING`,
        [tenantId, companyId, role]
      );
    }

    /* ==========================================================
       6. Ward/Bed minimal setup (only for hospitals)
       ========================================================== */
    if (subIndustry === "hospital") {
      await client.query(
        `INSERT INTO hms_ward
          (id, tenant_id, company_id, name, is_active)
         VALUES (gen_random_uuid(), $1, $2, 'General Ward', true)
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

    /* ==========================================================
       7. Mark provisioning completed
       ========================================================== */
    await client.query(
      `UPDATE provisioning_queue
       SET status='done', finished_at=now()
       WHERE id=$1`,
      [job.id]
    );

    await client.query("COMMIT");
    console.log("[HMS Provisioning] Completed:", companyId);

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[HMS Provisioning] Error:", err);

    await client.query(
      `UPDATE provisioning_queue
       SET status='failed', finished_at=now(), error=$2
       WHERE id=$1`,
      [job.id, err.message]
    );

  } finally {
    client.release();
  }
}
