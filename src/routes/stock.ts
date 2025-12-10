// server/src/routes/stock.ts
import { Router } from "express";
import db from "../db";
import { allocateBatches } from "../services/batchAllocator";
import { v4 as uuid } from "uuid";

const router = Router();

/* ---------------------------------------------------------
   POST /stock/allocate
   → returns batches for POS
--------------------------------------------------------- */
router.post("/stock/allocate", async (req, res) => {
  const { product_id, quantity, strategy } = req.body;

  try {
    const allocation = await allocateBatches({
      productId: product_id,
      quantity,
      strategy,
    });

    res.json({ ok: true, allocation });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/* ---------------------------------------------------------
   POST /stock/commit
   → writes ledger + updates batch quantities
--------------------------------------------------------- */
router.post("/stock/commit", async (req, res) => {
  const { product_id, allocation, reference, movement_type = "sale" } = req.body;

  try {
    await db.tx(async (t) => {
      for (const a of allocation) {
        // reduce qty
        await t.none(
          `UPDATE hms_product_batch
           SET qty_on_hand = qty_on_hand - $1
           WHERE id = $2`,
          [a.qty, a.batch_id]
        );

        // ledger entry
        await t.none(
          `INSERT INTO hms_product_stock_ledger (
            id, product_id, batch_id, movement_type,
            qty_change, qty_balance, reference
          )
          VALUES ($1,$2,$3,$4,$5,
            (SELECT qty_on_hand FROM hms_product_batch WHERE id=$3),
            $6
          )`,
          [
            uuid(),
            product_id,
            a.batch_id,
            movement_type,
            -a.qty,
            reference,
          ]
        );
      }
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

export default router;
