// server/src/industries/retail/provisioning.ts
import { pool } from "../../db";

/**
 * Retail provisioning module
 * Export: async function provision(tenantId, companyId, userId, payload)
 *
 * Payload structure expected:
 * {
 *   storeLocations: [{ name, address? }],
 *   registers: [{ name, currency }],
 *   defaultCategories: [ "Apparel", ... ],
 *   taxRegion: { countryId, defaultTaxPercent },
 *   pricingPolicy: "retail" | "wholesale" | "mixed",
 *   paymentMethods: ["cash","card",...],
 *   seedOpeningInventory: boolean
 * }
 *
 * The function is idempotent: uses ON CONFLICT DO NOTHING / UPSERT where possible.
 */
export async function provision(tenantId: string, companyId: string, userId: string, payload: any) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const {
      storeLocations = [],
      registers = [],
      defaultCategories = [],
      taxRegion = { countryId: null, defaultTaxPercent: 0 },
      pricingPolicy = "retail",
      paymentMethods = [],
      seedOpeningInventory = false,
    } = payload || {};

    /* 1) Store locations */
    for (const s of storeLocations) {
      const name = String(s.name || "Unnamed").trim();
      const address = s.address ? String(s.address).trim() : null;
      await client.query(
        `INSERT INTO store_location (id, tenant_id, company_id, name, address, is_active, created_by)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, true, $5)
         ON CONFLICT (company_id, name) DO NOTHING`,
        [tenantId, companyId, name, address, userId]
      );
    }

    /* 2) POS registers */
    for (const r of registers) {
      const name = String(r.name || "POS").trim();
      const currency = String(r.currency || "USD").trim();
      await client.query(
        `INSERT INTO pos_register (id, tenant_id, company_id, name, currency, is_active, created_by)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, true, $5)
         ON CONFLICT (company_id, name) DO NOTHING`,
        [tenantId, companyId, name, currency, userId]
      );
    }

    /* 3) Product categories */
    const categories = Array.isArray(defaultCategories) && defaultCategories.length ? defaultCategories : ["General"];
    for (const cat of categories) {
      const name = String(cat).trim();
      await client.query(
        `INSERT INTO product_category (id, tenant_id, company_id, name, is_active)
         VALUES (gen_random_uuid(), $1, $2, $3, true)
         ON CONFLICT (company_id, name) DO NOTHING`,
        [tenantId, companyId, name]
      );
    }

    /* 4) Tax rate - upsert */
    if (taxRegion && taxRegion.countryId) {
      const countryId = String(taxRegion.countryId);
      const rate = Number(taxRegion.defaultTaxPercent) || 0;
      await client.query(
        `INSERT INTO tax_rate (id, tenant_id, company_id, name, rate, country_id, is_active)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, true)
         ON CONFLICT (company_id, name)
         DO UPDATE SET rate = EXCLUDED.rate, country_id = EXCLUDED.country_id, is_active = true`,
        [tenantId, companyId, "Default Tax", rate, countryId]
      );
    }

    /* 5) Pricing policy saved into company_settings (or company table) */
    await client.query(
      `INSERT INTO company_settings (company_id, settings_json, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (company_id)
       DO UPDATE SET settings_json = company_settings.settings_json || $2::jsonb, updated_at = now()`,
      [companyId, JSON.stringify({ pricingPolicy })]
    );

    /* 6) Payment methods (placeholders) */
    const pmDefs = paymentMethods.length ? paymentMethods : ["cash", "card"];
    for (const pm of pmDefs) {
      const name = pm;
      await client.query(
        `INSERT INTO payment_method (id, tenant_id, company_id, name, provider, config_json, is_active)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, true)
         ON CONFLICT (company_id, name) DO NOTHING`,
        [tenantId, companyId, name, name, JSON.stringify({})]
      );
    }

    /* 7) Optional: seed opening inventory (small demo catalog) */
    if (seedOpeningInventory) {
      // demo products list (small)
      const demoProducts = [
        { sku: "DEMO-TSHIRT", name: "Demo T-Shirt", category: "Apparel", price: 499 },
        { sku: "DEMO-MUG", name: "Demo Mug", category: "General", price: 199 },
        { sku: "DEMO-USB", name: "Demo USB Cable", category: "Electronics", price: 299 },
      ];

      for (const p of demoProducts) {
        // ensure category exists
        await client.query(
          `INSERT INTO product_category (id, tenant_id, company_id, name, is_active)
           VALUES (gen_random_uuid(), $1, $2, $3, true)
           ON CONFLICT (company_id, name) DO NOTHING`,
          [tenantId, companyId, p.category]
        );

        // product upsert
        const prodRes = await client.query(
          `INSERT INTO product (id, tenant_id, company_id, sku, name, sale_price, is_active)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, true)
           ON CONFLICT (company_id, sku)
           DO UPDATE SET name = EXCLUDED.name, sale_price = EXCLUDED.sale_price, is_active = true
           RETURNING id`,
          [tenantId, companyId, p.sku, p.name, p.price]
        );
        const productId = prodRes.rows[0]?.id;

        // opening stock: insert into stock_move or opening_stock table depending on schema
        // We'll insert into a generic "opening_stock" table if exists, else into stock_move (attempt both)
        try {
          await client.query(
            `INSERT INTO opening_stock (id, tenant_id, company_id, product_id, quantity, created_by, created_at)
             VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, now())
             ON CONFLICT (company_id, product_id) DO NOTHING`,
            [tenantId, companyId, productId, 10, userId]
          );
        } catch (e) {
          // fallback to stock_move
          await client.query(
            `INSERT INTO stock_move (id, tenant_id, company_id, product_id, qty, move_type, created_by, created_at)
             VALUES (gen_random_uuid(), $1, $2, $3, $4, 'opening', $5, now())`,
            [tenantId, companyId, productId, 10, userId]
          );
        }
      }
    }

    /* 8) mark provisioning metadata (company_settings or provisioning_log) */
    await client.query(
      `INSERT INTO provisioning_log (id, tenant_id, company_id, user_id, industry, status, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'done', now())`,
      [tenantId, companyId, userId, "retail"]
    );

    await client.query("COMMIT");
    console.log("[retail provisioning] completed for company:", companyId);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[retail provisioning] error:", err);
    // propagate error to caller (worker will mark job failed)
    throw err;
  } finally {
    client.release();
  }
}
