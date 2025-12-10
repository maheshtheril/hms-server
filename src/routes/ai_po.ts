// server/src/routes/ai_po.ts
import { Router, Request, Response } from "express";
import db from "../db"; // expects db.pool to be a pg.Pool
import { v4 as uuid } from "uuid";

const router = Router();

/**
 * POST /ai/po/import
 * Body: { lines: [ { name, salt, batch_no, expiry, qty, cost, mrp } ] }
 *
 * Creates PO, GRN, products (if missing), batches, grn_lines and ledger entries
 * inside a single DB transaction using pool.connect().
 */
router.post("/ai/po/import", async (req: Request, res: Response) => {
  const { lines } = req.body;
  if (!Array.isArray(lines) || lines.length === 0) {
    return res.status(400).json({ error: "lines array required" });
  }

  const grnId = uuid();
  const poId = uuid();

  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");

    // Create PO header (minimal)
    await client.query(
      `INSERT INTO purchase_order (id, status, created_at, updated_at)
       VALUES ($1, 'received', NOW(), NOW())`,
      [poId]
    );

    // Create GRN header (minimal)
    await client.query(
      `INSERT INTO grn (id, po_id, created_at, updated_at)
       VALUES ($1, $2, NOW(), NOW())`,
      [grnId, poId]
    );

    for (const line of lines) {
      // Defensive normalization
      const name = (line.name || "").trim();
      const salt = (line.salt || "").trim();
      const batchNo = line.batch_no || null;
      const expiry = line.expiry || null;
      const qty = Number(line.qty || 0);
      const cost = typeof line.cost === "number" ? line.cost : Number(line.cost || 0);
      const mrp = typeof line.mrp === "number" ? line.mrp : Number(line.mrp || 0);

      if (!name) {
        // skip empty lines but continue processing others
        continue;
      }

      // Check if product exists (case-insensitive)
      const prodRes = await client.query(
        `SELECT id FROM hms_product WHERE name ILIKE $1 LIMIT 1`,
        [name]
      );

      let productId: string;
      if (prodRes.rowCount > 0) {
        productId = prodRes.rows[0].id;
      } else {
        productId = uuid();
        await client.query(
          `INSERT INTO hms_product (
             id, sku, name, description, price, default_cost,
             uom, is_stockable, is_service, created_at, updated_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,true,false,NOW(),NOW())`,
          [
            productId,
            batchNo || null,
            name,
            salt || null,
            mrp || cost || 0,
            cost || 0,
            "Unit",
          ]
        );
      }

      // Create batch
      const batchId = uuid();
      await client.query(
        `INSERT INTO hms_product_batch (
           id, product_id, batch_no, expiry_date,
           qty_on_hand, cost, mrp, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NOW())`,
        [batchId, productId, batchNo, expiry, qty, cost, mrp]
      );

      // Insert GRN line
      await client.query(
        `INSERT INTO grn_line (
           id, grn_id, product_id, batch_id, qty, cost, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,NOW(),NOW())`,
        [uuid(), grnId, productId, batchId, qty, cost]
      );

      // Insert stock ledger entry (purchase)
      // Read current qty_on_hand (should equal qty we just inserted)
      // but query to be safe in concurrent scenarios
      const qtyRow = await client.query(
        `SELECT qty_on_hand FROM hms_product_batch WHERE id = $1`,
        [batchId]
      );
      const qtyBalance = qtyRow.rowCount > 0 ? Number(qtyRow.rows[0].qty_on_hand) : qty;

      await client.query(
        `INSERT INTO hms_product_stock_ledger (
           id, product_id, batch_id, movement_type,
           qty_change, qty_balance, reference, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
        [uuid(), productId, batchId, "purchase", qty, qtyBalance, `AI-GRN-${grnId}`]
      );
    }

    await client.query("COMMIT");
    return res.json({ ok: true, grn_id: grnId, po_id: poId });
  } catch (err: any) {
    try {
      await client.query("ROLLBACK");
    } catch (rbErr) {
      console.error("Rollback failed:", rbErr);
    }
    console.error("Error in /ai/po/import:", err);
    return res.status(500).json({ error: err?.message || "Internal server error" });
  } finally {
    client.release();
  }
});

export default router;
