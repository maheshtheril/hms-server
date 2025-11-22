// server/src/industries/manufacturing/provisioning.ts
/**
 * Manufacturing / MRP provisioner
 * Seeds BOM templates, workcenters, routings, default product categories, and sample SKU templates.
 *
 * payload (optional):
 * {
 *   sampleBOMs?: boolean,
 *   workcenters?: string[],
 *   routings?: string[]
 * }
 */

import { pool } from "../../db";

export async function provision(tenantId: string, companyId: string, userId: string, payload: any = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const workcenters = Array.isArray(payload.workcenters) && payload.workcenters.length ? payload.workcenters : ["Assembly", "Painting", "Packaging"];
    const routings = Array.isArray(payload.routings) && payload.routings.length ? payload.routings : ["Standard Assembly"];

    // 1) Product categories for manufacturing
    await client.query(
      `INSERT INTO product_category (id, tenant_id, company_id, name, is_active)
       VALUES (gen_random_uuid(), $1, $2, 'Raw Materials', true)
       ON CONFLICT (company_id, name) DO NOTHING`,
      [tenantId, companyId]
    );
    await client.query(
      `INSERT INTO product_category (id, tenant_id, company_id, name, is_active)
       VALUES (gen_random_uuid(), $1, $2, 'Finished Goods', true)
       ON CONFLICT (company_id, name) DO NOTHING`,
      [tenantId, companyId]
    );

    // 2) Workcenters
    for (const wc of workcenters) {
      await client.query(
        `INSERT INTO manufacturing_workcenter (id, tenant_id, company_id, name, is_active)
         VALUES (gen_random_uuid(), $1, $2, $3, true)
         ON CONFLICT (company_id, name) DO NOTHING`,
        [tenantId, companyId, wc]
      );
    }

    // 3) Routings
    for (const r of routings) {
      await client.query(
        `INSERT INTO manufacturing_routing (id, tenant_id, company_id, name)
         VALUES (gen_random_uuid(), $1, $2, $3)
         ON CONFLICT (company_id, name) DO NOTHING`,
        [tenantId, companyId, r]
      );
    }

    // 4) Basic BOM and Sample product template
    if (payload.sampleBOMs !== false) {
      // Sample finished product
      await client.query(
        `INSERT INTO product (id, tenant_id, company_id, name, sku, category, is_active)
         VALUES (gen_random_uuid(), $1, $2, 'Sample Widget', 'WIDGET-001', 'Finished Goods', true)
         ON CONFLICT (company_id, sku) DO NOTHING`,
        [tenantId, companyId]
      );

      // Sample raw material
      await client.query(
        `INSERT INTO product (id, tenant_id, company_id, name, sku, category, is_active)
         VALUES (gen_random_uuid(), $1, $2, 'Raw Bolt', 'RM-BOLT-001', 'Raw Materials', true)
         ON CONFLICT (company_id, sku) DO NOTHING`,
        [tenantId, companyId]
      );

      // Create a BOM linking Sample Widget to Raw Bolt (if you have product_bom table)
      await client.query(
        `INSERT INTO product_bom (id, tenant_id, company_id, product_sku, component_sku, qty)
         VALUES (gen_random_uuid(), $1, $2, 'WIDGET-001', 'RM-BOLT-001', 4)
         ON CONFLICT (company_id, product_sku, component_sku) DO NOTHING`,
        [tenantId, companyId]
      );
    }

    // 5) Default manufacturing settings
    await client.query(
      `INSERT INTO manufacturing_settings (company_id, default_routing, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (company_id) DO UPDATE SET default_routing = EXCLUDED.default_routing, updated_at = now()`,
      [companyId, routings[0] || null]
    );

    // 6) Mark provisioned metadata
    await client.query(
      `INSERT INTO provisioned_industries (id, tenant_id, company_id, industry_key, payload, provisioned_at)
       VALUES (gen_random_uuid(), $1, $2, 'manufacturing', $3, now())
       ON CONFLICT (company_id, industry_key) DO UPDATE SET payload = EXCLUDED.payload, provisioned_at = now()`,
      [tenantId, companyId, JSON.stringify({ workcenters, routings })]
    );

    await client.query("COMMIT");
    console.log(`[manufacturing.provisioning] completed for company ${companyId}`);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[manufacturing.provisioning] error:", err);
    throw err;
  } finally {
    client.release();
  }
}

export default provision;
