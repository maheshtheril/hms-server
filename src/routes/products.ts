// server/src/routes/products.ts
import { Router } from "express";
import db from "../db";
import { v4 as uuid } from "uuid";

const router = Router();

/* ---------------------------------------------------------
   GET /products  (list)
--------------------------------------------------------- */
router.get("/products", async (req, res) => {
  const { company_id, tenant_id } = req.query;

  const rows = await db.any(
    `SELECT id, sku, name, price, is_stockable, is_service
     FROM hms_product
     WHERE tenant_id = $1 AND company_id = $2
     ORDER BY created_at DESC`,
    [tenant_id, company_id]
  );

  res.json(rows);
});

/* ---------------------------------------------------------
   GET /products/:id  (hydrated product)
--------------------------------------------------------- */
router.get("/products/:id", async (req, res) => {
  const { id } = req.params;

  const product = await db.oneOrNone(
    `SELECT * FROM hms_product WHERE id = $1`,
    [id]
  );
  if (!product) return res.status(404).json({ error: "Product not found" });

  const batches = await db.any(
    `SELECT * 
     FROM hms_product_batch 
     WHERE product_id = $1 
     ORDER BY expiry_date ASC`,
    [id]
  );

  const suppliers = await db.any(
    `SELECT * 
     FROM hms_product_supplier 
     WHERE product_id = $1`,
    [id]
  );

  const tax_rules = await db.any(
    `SELECT m.*, t.name AS tax_name, t.rate
     FROM company_tax_maps m
     JOIN company_taxes t ON t.id = m.tax_id
     WHERE m.entity_type = 'product'
       AND m.entity_id = $1
       AND m.company_id = $2`,
    [id, product.company_id]
  );

  const ledger = await db.any(
    `SELECT *
     FROM hms_product_stock_ledger
     WHERE product_id = $1
     ORDER BY created_at DESC
     LIMIT 50`,
    [id]
  );

  const variants = await db.any(
    `SELECT *
     FROM product_variant
     WHERE product_id = $1`,
    [id]
  );

  const media = await db.any(
    `SELECT *
     FROM hms_product_media
     WHERE product_id = $1`,
    [id]
  );

  res.json({
    product,
    batches,
    suppliers,
    tax_rules,
    ledger,
    variants,
    media,
  });
});

/* ---------------------------------------------------------
   POST /products  (create)
--------------------------------------------------------- */
router.post("/products", async (req, res) => {
  const id = uuid();
  const body = req.body;

  try {
    await db.tx(async (t) => {
      // main product
      await t.none(
        `INSERT INTO hms_product (
          id, tenant_id, company_id, sku, name,
          description, short_description,
          price, default_cost,
          is_stockable, is_service,
          uom, barcode, barcode_type, metadata
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          id,
          body.tenant_id,
          body.company_id,
          body.sku,
          body.name,
          body.description,
          body.short_description,
          body.price,
          body.default_cost,
          body.is_stockable,
          body.is_service,
          body.uom,
          body.barcode,
          body.barcode_type,
          body.metadata || {},
        ]
      );

      // batches
      for (const b of body.batches || []) {
        await t.none(
          `INSERT INTO hms_product_batch (
            id, product_id, batch_no, expiry_date,
            qty_on_hand, mrp, cost
          ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            uuid(),
            id,
            b.batch_no,
            b.expiry_date,
            b.qty_on_hand,
            b.mrp || 0,
            b.cost || body.default_cost || 0,
          ]
        );
      }

      // suppliers
      for (const s of body.suppliers || []) {
        await t.none(
          `INSERT INTO hms_product_supplier (
            id, product_id, supplier_name, price, lead_time_days
          ) VALUES ($1,$2,$3,$4,$5)`,
          [
            uuid(),
            id,
            s.supplier_name,
            s.price,
            s.lead_time_days,
          ]
        );
      }

      // tax rules
      for (const tr of body.tax_rules || []) {
        await t.none(
          `INSERT INTO company_tax_maps (
            id, company_id, entity_type, entity_id,
            tax_id, rate, account_id
          ) VALUES ($1,$2,'product',$3,$4,$5,$6)`,
          [
            uuid(),
            body.company_id,
            id,
            tr.tax_id,
            tr.rate,
            tr.account_id,
          ]
        );
      }

      // variants
      for (const v of body.variants || []) {
        await t.none(
          `INSERT INTO product_variant (
            id, product_id, attribute, value, price_override
          ) VALUES ($1,$2,$3,$4,$5)`,
          [
            uuid(),
            id,
            v.attribute,
            v.value,
            v.price_override,
          ]
        );
      }
    });

    res.json({ ok: true, id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

/* ---------------------------------------------------------
   PUT /products/:id  (update everything)
--------------------------------------------------------- */
router.put("/products/:id", async (req, res) => {
  const { id } = req.params;
  const body = req.body;

  try {
    await db.tx(async (t) => {
      // update product
      await t.none(
        `UPDATE hms_product
         SET sku=$1, name=$2, description=$3, short_description=$4,
             price=$5, default_cost=$6, is_stockable=$7, is_service=$8,
             uom=$9, barcode=$10, barcode_type=$11, metadata=$12,
             updated_at = NOW()
         WHERE id=$13`,
        [
          body.sku,
          body.name,
          body.description,
          body.short_description,
          body.price,
          body.default_cost,
          body.is_stockable,
          body.is_service,
          body.uom,
          body.barcode,
          body.barcode_type,
          body.metadata || {},
          id,
        ]
      );

      // wipe + insert batches
      await t.none(
        `DELETE FROM hms_product_batch WHERE product_id = $1`,
        [id]
      );

      for (const b of body.batches || []) {
        await t.none(
          `INSERT INTO hms_product_batch (
            id, product_id, batch_no, expiry_date,
            qty_on_hand, mrp, cost
          ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            uuid(),
            id,
            b.batch_no,
            b.expiry_date,
            b.qty_on_hand,
            b.mrp || 0,
            b.cost || body.default_cost,
          ]
        );
      }

      // wipe + insert suppliers
      await t.none(
        `DELETE FROM hms_product_supplier WHERE product_id = $1`,
        [id]
      );

      for (const s of body.suppliers || []) {
        await t.none(
          `INSERT INTO hms_product_supplier (
            id, product_id, supplier_name, price, lead_time_days
          ) VALUES ($1,$2,$3,$4,$5)`,
          [
            uuid(),
            id,
            s.supplier_name,
            s.price,
            s.lead_time_days,
          ]
        );
      }

      // wipe + insert tax maps
      await t.none(
        `DELETE FROM company_tax_maps 
         WHERE entity_type='product' AND entity_id=$1`,
        [id]
      );

      for (const tr of body.tax_rules || []) {
        await t.none(
          `INSERT INTO company_tax_maps (
            id, company_id, entity_type, entity_id,
            tax_id, rate, account_id
          ) VALUES ($1,$2,'product',$3,$4,$5,$6)`,
          [
            uuid(),
            body.company_id,
            id,
            tr.tax_id,
            tr.rate,
            tr.account_id,
          ]
        );
      }

      // wipe + insert variants
      await t.none(
        `DELETE FROM product_variant WHERE product_id = $1`,
        [id]
      );

      for (const v of body.variants || []) {
        await t.none(
          `INSERT INTO product_variant (
            id, product_id, attribute, value, price_override
          ) VALUES ($1,$2,$3,$4,$5)`,
          [
            uuid(),
            id,
            v.attribute,
            v.value,
            v.price_override,
          ]
        );
      }
    });

    res.json({ ok: true, id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

export default router;
