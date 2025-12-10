// server/src/routes/ai.ts
import { Router, Request, Response } from "express";
import db from "../db"; // your db module (provides pool)
import { v4 as uuid } from "uuid";

const router = Router();

/**
 * POST /ai/products
 * Ingest AI-extracted product payload and create product + first batch in a transaction.
 *
 * Expected body shape:
 * {
 *   sku, name, short_description, description, price, default_cost, uom,
 *   batches: [{ batch_no, expiry_date, qty_on_hand, cost, mrp }]
 * }
 */
router.post("/ai/products", async (req: Request, res: Response) => {
  const p = req.body;

  // basic validation
  if (!p || !p.name) {
    return res.status(400).json({ error: "Missing product payload (name required)" });
  }

  const productId = uuid();

  // Acquire a client from the pool and run a transaction
  const client = await db.pool.connect();

  try {
    await client.query("BEGIN");

    // Insert product
    const insertProductSql = `
      INSERT INTO hms_product (
        id, sku, name, short_description,
        description, price, default_cost,
        is_stockable, uom, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW())
    `;

    await client.query(insertProductSql, [
      productId,
      p.sku || null,
      p.name,
      p.short_description || null,
      p.description || null,
      typeof p.price === "number" ? p.price : p.mrp || 0,
      typeof p.default_cost === "number" ? p.default_cost : p.cost || 0,
      true, // AI-created products are stockable by default
      p.uom || "Unit",
    ]);

    // If batch info is provided, insert first batch
    if (Array.isArray(p.batches) && p.batches.length > 0) {
      const b = p.batches[0];
      const batchId = uuid();

      const insertBatchSql = `
        INSERT INTO hms_product_batch (
          id, product_id, batch_no, expiry_date,
          qty_on_hand, cost, mrp, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NOW())
      `;

      await client.query(insertBatchSql, [
        batchId,
        productId,
        b.batch_no || null,
        b.expiry_date || null,
        typeof b.qty_on_hand === "number" ? b.qty_on_hand : Number(b.qty || 0),
        typeof b.cost === "number" ? b.cost : p.default_cost || 0,
        typeof b.mrp === "number" ? b.mrp : p.mrp || 0,
      ]);

      // Create initial ledger entry for the batch (purchase / opening balance)
      const ledgerId = uuid();
      const insertLedgerSql = `
        INSERT INTO hms_product_stock_ledger (
          id, product_id, batch_id, movement_type,
          qty_change, qty_balance, reference, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
      `;

      // Read qty_on_hand from the batch we just created (should equal inserted qty)
      const qtyForLedger = typeof b.qty_on_hand === "number" ? b.qty_on_hand : Number(b.qty || 0);

      await client.query(insertLedgerSql, [
        ledgerId,
        productId,
        batchId,
        "opening",
        qtyForLedger,
        qtyForLedger,
        `AI-OPENING-${productId}`,
      ]);
    }

    await client.query("COMMIT");

    return res.json({ ok: true, product_id: productId });
  } catch (err: any) {
    try {
      await client.query("ROLLBACK");
    } catch (rbErr) {
      // swallow rollback error but log if you have logger
      console.error("Rollback error:", rbErr);
    }
    console.error("Error in /ai/products:", err);
    return res.status(500).json({ error: err?.message || "Internal server error" });
  } finally {
    client.release();
  }
});

export default router;
