// server/src/services/batchAllocator.ts
import db from "../db";

export type AllocationRequest = {
  productId: string;
  quantity: number;
  strategy?: "FEFO" | "FIFO";
};

export type AllocationEntry = {
  batch_id: string;
  qty: number;
  expiry_date: string | null;
  cost: number;
};

export type AllocationResult = AllocationEntry[];

/**
 * allocateBatches
 * - Uses db.query(...) (node-postgres style) instead of pg-promise helpers.
 * - FEFO = earliest expiry first (expiry_date ASC NULLS LAST)
 * - FIFO = earliest created_at first (created_at ASC)
 *
 * Throws if insufficient stock.
 */
export async function allocateBatches({
  productId,
  quantity,
  strategy = "FEFO",
}: AllocationRequest): Promise<AllocationResult> {
  // Choose SQL ordering based on strategy
  const orderBy =
    strategy === "FEFO"
      ? "expiry_date ASC NULLS LAST, created_at ASC"
      : "created_at ASC";

  const sql = `
    SELECT id, batch_no, qty_on_hand, expiry_date, cost
    FROM hms_product_batch
    WHERE product_id = $1 AND qty_on_hand > 0
    ORDER BY ${orderBy}
  `;

  const res = await db.query(sql, [productId]);
  const rows = (res && res.rows) ? res.rows : [];

  // Normalize numeric values to numbers
  const batches = rows.map((r: any) => ({
    id: r.id,
    batch_no: r.batch_no,
    qty_on_hand: Number(r.qty_on_hand || 0),
    expiry_date: r.expiry_date || null,
    cost: Number(r.cost || 0),
  }));

  let remaining = Number(quantity || 0);
  const result: AllocationResult = [];

  for (const b of batches) {
    if (remaining <= 0) break;

    const take = Math.min(remaining, b.qty_on_hand);

    if (take <= 0) continue;

    result.push({
      batch_id: b.id,
      qty: take,
      expiry_date: b.expiry_date,
      cost: b.cost,
    });

    remaining -= take;
  }

  if (remaining > 0) {
    throw new Error(
      `Insufficient stock for product ${productId}. Missing ${remaining}.`
    );
  }

  return result;
}
