// server/src/industries/globalInventory/provisioning.ts
import { pool } from "../../db";

/**
 * Provision baseline inventory for a tenant/company:
 * - stock locations (warehouse / transit / returns)
 * - default product categories
 * - default UOMs (if you keep uom table; otherwise leave placeholder)
 * - a sample product and initial stock (writes stock_ledger + stock_levels)
 *
 * Idempotent: uses ON CONFLICT DO NOTHING / upserts.
 */
export async function provision(tenantId: string, companyId: string, userId: string, payload: any = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1) Stock locations (warehouse, store, returns)
    await client.query(
      `INSERT INTO hms_stock_locations (id, tenant_id, company_id, name, code, is_default, metadata, created_at, created_by)
       VALUES
       (gen_random_uuid(), $1, $2, 'Main Warehouse', 'WH_MAIN', true, '{}', now(), $3),
       (gen_random_uuid(), $1, $2, 'Transit', 'TRANSIT', false, '{}', now(), $3),
       (gen_random_uuid(), $1, $2, 'Returns', 'RETURNS', false, '{}', now(), $3)
       ON CONFLICT (company_id, code) DO NOTHING`,
      [tenantId, companyId, userId]
    );

    // 2) Default categories
    const categories = payload.categories || ["Default", "Consumables", "Finished Goods"];
    for (const name of categories) {
      await client.query(
        `INSERT INTO hms_product_category (id, tenant_id, company_id, name, slug, metadata, created_at)
         VALUES (gen_random_uuid(), $1, $2, $3, lower(regexp_replace($3, '\\s+', '-', 'g')), '{}', now())
         ON CONFLICT (company_id, name) DO NOTHING`,
        [tenantId, companyId, name]
      );
    }

    // 3) Default UOMs - if you have a separate uom table, seed here.
    // (schema seems to store UOM on product rows; placeholder comment left intentionally)

    // 4) Provision a sample product if none exist (idempotent)
    const { rows: productCount } = await client.query(
      `SELECT count(*)::int as cnt FROM hms_product WHERE company_id = $1`,
      [companyId]
    );
    if (productCount[0].cnt === 0) {
      const productRes = await client.query(
        `INSERT INTO hms_product
          (id, tenant_id, company_id, sku, name, description, is_stockable, is_service, uom, valuation_method, price, currency, default_cost, is_active, created_at, created_by)
         VALUES (gen_random_uuid(), $1, $2, 'SAMPLE-001', 'Sample Product', 'Provisioned sample product', true, false, 'each', 'fifo', 10.00, 'USD', 0.00, true, now(), $3)
         RETURNING id`,
        [tenantId, companyId, userId]
      );
      const sampleProductId: string = productRes.rows[0].id;

      // add category rel: attach to first category
      const { rows: catRow } = await client.query(
        `SELECT id FROM hms_product_category WHERE company_id = $1 LIMIT 1`,
        [companyId]
      );
      if (catRow[0]) {
        await client.query(
          `INSERT INTO hms_product_category_rel (product_id, category_id)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [sampleProductId, catRow[0].id]
        );
      }

      // 5) Seed initial stock: find default location
      const { rows: loc } = await client.query(
        `SELECT id FROM hms_stock_locations WHERE company_id=$1 AND is_default = true LIMIT 1`,
        [companyId]
      );
      const locId = loc[0]?.id;

      if (locId) {
        // stock ledger entry
        await client.query(
          `INSERT INTO hms_product_stock_ledger
            (id, tenant_id, company_id, product_id, location, change_qty, balance_qty, movement_type, reference, cost, created_at, created_by)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $5, 'initial', 'provision_initial', 0.0, now(), $6)`,
          [tenantId, companyId, sampleProductId, locId, 100, userId]
        );

        // stock_levels table: upsert
        await client.query(
          `INSERT INTO hms_stock_levels (id, tenant_id, company_id, product_id, batch_id, location_id, quantity, reserved, updated_at, metadata)
           VALUES (gen_random_uuid(), $1, $2, $3, NULL, $4, $5, 0, now(), '{}')
           ON CONFLICT (company_id, product_id, location_id) DO UPDATE
           SET quantity = GREATEST(hms_stock_levels.quantity, EXCLUDED.quantity), updated_at = now()`,
          [tenantId, companyId, sampleProductId, locId, 100]
        );
      }
    }

    // 6) Optionally seed suppliers / reorder rules — left as future tasks

    await client.query("COMMIT");
    console.log("[globalInventory.provision] done for", companyId);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[globalInventory.provision] failed:", err);
    throw err;
  } finally {
    client.release();
  }
}
