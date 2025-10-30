// server/src/services/productsAdvancedService.ts
// when getClient is the default export and q is named
import getClient, { q } from "../dbCompat";


/**
 * Advanced product service: batches, FIFO consumption by batch & expiry, barcode lookup, UOM conversions.
 * - Assumes migrations for hms_product_batch, batch_id in stock ledger, uom conversion exist.
 * - All operations are tenant+company scoped.
 */

function ensureObject(v: any) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

/* -------------------------
   Types
   ------------------------- */
type CreateBatchPayload = {
  tenantId: string;
  companyId: string;
  productId: string;
  batch_no: string;
  expiry_date?: string | null; // ISO date or null
  mrp?: number | null;
  cost?: number | null;
  qty?: number; // initial qty (in base units)
  vendor_barcode?: string | null;
  internal_barcode?: string | null;
  createdBy?: string | null;
  metadata?: any;
};

type ReceivePayload = {
  tenantId: string;
  companyId: string;
  productId: string;
  batch_no?: string | null; // optional: if not provided, a batch will be created (generated)
  expiry_date?: string | null;
  mrp?: number | null;
  cost?: number | null;
  qty: number; // incoming qty in base units
  location?: string | null;
  reference?: string | null; // PO/GRN ref
  createdBy?: string | null;
  metadata?: any;
};

type IssuePayload = {
  tenantId: string;
  companyId: string;
  productId: string;
  qty: number; // qty to issue (base units)
  location?: string | null;
  reference?: string | null; // sale/invoice id
  createdBy?: string | null;
  consumeStrategy?: "fifo" | "expiry_fifo" | "batch_select"; // policy
  selected_batch_id?: string | null; // if batch_select
};

/* -------------------------
   Core helpers
   ------------------------- */

async function getBatchesForConsumption(client: any, tenantId: string, companyId: string, productId: string, allowExpired = false) {
  // return batches with available qty > 0 ordered by expiry_date asc then created_at asc (FIFO by expiry then time)
  // Use the batch stock MV or compute on the fly
  const sql = `
    SELECT b.id, b.batch_no, b.expiry_date, b.mrp, b.cost,
      COALESCE(SUM(sl.change_qty),0)::numeric(16,6) AS qty
    FROM public.hms_product_batch b
    LEFT JOIN public.hms_product_stock_ledger sl ON sl.batch_id = b.id
    WHERE b.product_id = $1 AND b.tenant_id = $2 AND b.company_id = $3
    GROUP BY b.id, b.batch_no, b.expiry_date, b.mrp, b.cost
    HAVING COALESCE(SUM(sl.change_qty),0) > 0
    ORDER BY (b.expiry_date IS NULL), b.expiry_date ASC NULLS LAST, b.created_at ASC;
  `;
  // This orders batches with earliest expiry first; batches without expiry go last.
  const r = await client.query(sql, [productId, tenantId, companyId]);
  // optionally filter expired if not allowed
  const now = new Date();
  const rows = r.rows.filter((row: any) => {
    if (!allowExpired && row.expiry_date) {
      return new Date(row.expiry_date.toString()) >= now;
    }
    return true;
  });
  return rows;
}

/* -------------------------
   Create Batch
   ------------------------- */

export async function createBatch(payload: CreateBatchPayload) {
  const client = await getClient();
  try {
    await client.query("BEGIN");

    // upsert batch by (tenant,company,product,batch_no) — unique enforced by migration
    const sql = `
      INSERT INTO public.hms_product_batch
        (tenant_id, company_id, product_id, batch_no, expiry_date, mrp, cost, qty_on_hand, vendor_barcode, internal_barcode, created_at, created_by, metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now(), $11, $12)
      ON CONFLICT (tenant_id, company_id, product_id, batch_no)
      DO UPDATE SET
         expiry_date = EXCLUDED.expiry_date,
         mrp = EXCLUDED.mrp,
         cost = EXCLUDED.cost,
         vendor_barcode = COALESCE(EXCLUDED.vendor_barcode, public.hms_product_batch.vendor_barcode),
         internal_barcode = COALESCE(EXCLUDED.internal_barcode, public.hms_product_batch.internal_barcode),
         metadata = public.hms_product_batch.metadata || EXCLUDED.metadata
      RETURNING *;
    `;
    const res = await client.query(sql, [
      payload.tenantId,
      payload.companyId,
      payload.productId,
      payload.batch_no,
      payload.expiry_date ? payload.expiry_date : null,
      payload.mrp ?? null,
      payload.cost ?? null,
      payload.qty ?? 0,
      payload.vendor_barcode ?? null,
      payload.internal_barcode ?? null,
      payload.createdBy ?? null,
      JSON.stringify(payload.metadata ?? {}),
    ]);
    const batch = res.rows[0];

    // ensure there's at least an opening ledger row reflecting the qty (0 if none)
    const openingQty = payload.qty ?? 0;
    if (Number(openingQty) !== 0) {
      // insert ledger row for this batch
      const curSum = await client.query(`SELECT COALESCE(SUM(change_qty),0)::numeric(16,6) AS cur FROM public.hms_product_stock_ledger WHERE batch_id = $1 FOR UPDATE`, [batch.id]);
      const cur = Number(curSum.rows[0]?.cur ?? 0);
      const newBal = cur + Number(openingQty);
      await client.query(
        `INSERT INTO public.hms_product_stock_ledger (tenant_id, company_id, product_id, location, change_qty, balance_qty, movement_type, reference, cost, created_at, created_by, batch_id, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now(), $10, $11, '{}'::jsonb)`,
        [payload.tenantId, payload.companyId, payload.productId, null, openingQty, newBal, "opening", "batch_create_opening", payload.cost ?? null, payload.createdBy ?? null, batch.id]
      );
    }

    await client.query("COMMIT");
    batch.metadata = ensureObject(batch.metadata);
    return { batch };
  } catch (err: any) {
    await client.query("ROLLBACK");
    console.error("productsAdvancedService.createBatch", err);
    return { error: "server_error", detail: err?.message };
  } finally {
    try { client.release(); } catch {}
  }
}

/* -------------------------
   Receive (GRN) — create batch if needed + ledger row
   ------------------------- */

export async function receiveGoods(payload: ReceivePayload) {
  const client = await getClient();
  try {
    await client.query("BEGIN");

    // If batch_no provided, upsert batch; otherwise create generated batch_no (timestamp)
    const batchNo = payload.batch_no ?? `B-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6)}`;

    // create or update batch (no opening qty — we'll record ledger separately)
    const batchRes = await client.query(
      `INSERT INTO public.hms_product_batch (tenant_id, company_id, product_id, batch_no, expiry_date, mrp, cost, created_at, created_by, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now(), $8, '{}'::jsonb)
       ON CONFLICT (tenant_id, company_id, product_id, batch_no)
       DO UPDATE SET expiry_date = EXCLUDED.expiry_date, mrp = EXCLUDED.mrp, cost = EXCLUDED.cost
       RETURNING *;`,
      [payload.tenantId, payload.companyId, payload.productId, batchNo, payload.expiry_date ?? null, payload.mrp ?? null, payload.cost ?? null, payload.createdBy ?? null]
    );
    const batch = batchRes.rows[0];

    // Insert ledger row for receipt
    const sumRes = await client.query(`SELECT COALESCE(SUM(change_qty),0)::numeric(16,6) AS cur FROM public.hms_product_stock_ledger WHERE batch_id = $1 FOR UPDATE`, [batch.id]);
    const cur = Number(sumRes.rows[0]?.cur ?? 0);
    const newBal = cur + Number(payload.qty);

    const ledgerSql = `
      INSERT INTO public.hms_product_stock_ledger
         (tenant_id, company_id, product_id, location, change_qty, balance_qty, movement_type, reference, cost, created_at, created_by, batch_id, metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now(), $10, $11, $12)
      RETURNING *;
    `;
    const ledgerRes = await client.query(ledgerSql, [
      payload.tenantId,
      payload.companyId,
      payload.productId,
      payload.location ?? null,
      payload.qty,
      newBal,
      "purchase",
      payload.reference ?? null,
      payload.cost ?? payload.cost ?? null,
      payload.createdBy ?? null,
      batch.id,
      JSON.stringify(payload.metadata ?? {}),
    ]);

    // Update batch.qty_on_hand denormalized field (optional)
    await client.query(`UPDATE public.hms_product_batch SET qty_on_hand = $1 WHERE id = $2`, [newBal, batch.id]);

    await client.query("COMMIT");
    const ledgerRow = ledgerRes.rows[0];
    ledgerRow.metadata = ensureObject(ledgerRow.metadata);
    return { ledger: ledgerRow, batch };
  } catch (err: any) {
    await client.query("ROLLBACK");
    console.error("productsAdvancedService.receiveGoods", err);
    return { error: "server_error", detail: err?.message };
  } finally {
    try { client.release(); } catch {}
  }
}

/* -------------------------
   Issue (consume) — FIFO by expiry_date then created_at
   ------------------------- */

export async function issueProduct(payload: IssuePayload) {
  const client = await getClient();
  try {
    await client.query("BEGIN");

    let remaining = Number(payload.qty);
    if (remaining <= 0) { await client.query("ROLLBACK"); return { error: "invalid_qty" }; }

    // If user selected specific batch, consume from that only
    const consumed: any[] = [];

    if (payload.consumeStrategy === "batch_select" && payload.selected_batch_id) {
      // lock batch ledger
      const sumRes = await client.query(`SELECT COALESCE(SUM(change_qty),0)::numeric(16,6) AS cur FROM public.hms_product_stock_ledger WHERE batch_id = $1 FOR UPDATE`, [payload.selected_batch_id]);
      const cur = Number(sumRes.rows[0]?.cur ?? 0);
      const take = Math.min(remaining, cur);
      if (take <= 0) { await client.query("ROLLBACK"); return { error: "batch_empty" }; }

      const newBal = cur - take;
      const insert = await client.query(
        `INSERT INTO public.hms_product_stock_ledger (tenant_id, company_id, product_id, location, change_qty, balance_qty, movement_type, reference, cost, created_at, created_by, batch_id, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now(), $10, $11, '{}'::jsonb) RETURNING *;`,
        [payload.tenantId, payload.companyId, payload.productId, payload.location ?? null, -take, newBal, "issue", payload.reference ?? null, null, payload.createdBy ?? null, payload.selected_batch_id]
      );
      // update batch.qty_on_hand
      await client.query(`UPDATE public.hms_product_batch SET qty_on_hand = $1 WHERE id = $2`, [newBal, payload.selected_batch_id]);
      consumed.push(insert.rows[0]);
      remaining -= take;
    } else {
      // default: FIFO by expiry (soonest expiry first), then by created_at
      const batches = await getBatchesForConsumption(client, payload.tenantId, payload.companyId, payload.productId, /*allowExpired=*/ false);

      for (const b of batches) {
        if (remaining <= 0) break;
        const avail = Number(b.qty);
        if (avail <= 0) continue;
        const take = Math.min(avail, remaining);
        // insert negative ledger row referencing batch
        const curSum = await client.query(`SELECT COALESCE(SUM(change_qty),0)::numeric(16,6) AS cur FROM public.hms_product_stock_ledger WHERE batch_id = $1 FOR UPDATE`, [b.id]);
        const cur = Number(curSum.rows[0]?.cur ?? 0);
        const newBal = cur - take;
        const insert = await client.query(
          `INSERT INTO public.hms_product_stock_ledger (tenant_id, company_id, product_id, location, change_qty, balance_qty, movement_type, reference, cost, created_at, created_by, batch_id, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now(), $10, $11, '{}'::jsonb) RETURNING *;`,
          [payload.tenantId, payload.companyId, payload.productId, payload.location ?? null, -take, newBal, "issue", payload.reference ?? null, b.cost ?? null, payload.createdBy ?? null, b.id]
        );
        // update batch.qty_on_hand
        await client.query(`UPDATE public.hms_product_batch SET qty_on_hand = $1 WHERE id = $2`, [newBal, b.id]);
        consumed.push(insert.rows[0]);
        remaining -= take;
      }

      // If still remaining > 0, optionally allow negative stock or fail
      if (remaining > 0) {
        // Policy: fail with insufficient_stock
        await client.query("ROLLBACK");
        return { error: "insufficient_stock", remaining };
      }
    }

    await client.query("COMMIT");
    return { consumed };
  } catch (err: any) {
    await client.query("ROLLBACK");
    console.error("productsAdvancedService.issueProduct", err);
    return { error: "server_error", detail: err?.message };
  } finally {
    try { client.release(); } catch {}
  }
}

/* -------------------------
   Barcode lookup helpers
   ------------------------- */

export async function findBatchByBarcode({ tenantId, companyId, barcode }: { tenantId: string; companyId: string; barcode: string }) {
  const sql = `
    SELECT * FROM public.hms_product_batch
    WHERE tenant_id = $1 AND company_id = $2 AND (vendor_barcode = $3 OR internal_barcode = $3)
    LIMIT 1;
  `;
  const r = await q(sql, [tenantId, companyId, barcode]);
  if (!r.rowCount) return null;
  const b = r.rows[0];
  b.metadata = ensureObject(b.metadata);
  return b;
}

/* -------------------------
   Utility: get current stock by product (all batches)
   ------------------------- */

export async function getProductStock({ tenantId, companyId, productId }: { tenantId: string; companyId: string; productId: string }) {
  // aggregate ledger
  const sql = `SELECT COALESCE(SUM(change_qty),0)::numeric(16,6) AS qty FROM public.hms_product_stock_ledger WHERE product_id = $1 AND tenant_id = $2 AND company_id = $3`;
  const r = await q(sql, [productId, tenantId, companyId]);
  const qty = Number(r.rows[0]?.qty ?? 0);
  // also list batch level qtys
  const batchesRes = await q(
    `SELECT b.id, b.batch_no, b.expiry_date, b.mrp, b.cost, COALESCE(SUM(sl.change_qty),0)::numeric(16,6) AS qty
     FROM public.hms_product_batch b
     LEFT JOIN public.hms_product_stock_ledger sl ON sl.batch_id = b.id
     WHERE b.product_id = $1 AND b.tenant_id = $2 AND b.company_id = $3
     GROUP BY b.id, b.batch_no, b.expiry_date, b.mrp, b.cost
     ORDER BY b.expiry_date ASC NULLS LAST`,
    [productId, tenantId, companyId]
  );
  return { qty, batches: batchesRes.rows.map((r: any) => ({ ...r, qty: Number(r.qty) })) };
}

/* -------------------------
   UOM conversion helpers
   ------------------------- */

export async function getUomConversion({ tenantId, companyId, productId, from_uom, to_uom }: { tenantId: string; companyId: string; productId: string; from_uom: string; to_uom: string }) {
  const r = await q(`SELECT factor FROM public.hms_product_uom_conversion WHERE product_id=$1 AND tenant_id=$2 AND company_id=$3 AND from_uom=$4 AND to_uom=$5 LIMIT 1`, [productId, tenantId, companyId, from_uom, to_uom]);
  if (!r.rowCount) return null;
  return Number(r.rows[0].factor);
}

/* -------------------------
   NEW: getProductById
   - Accepts productId that may be an actual id OR a barcode. Tries id first, then fallback to default_barcode lookup.
   - Returns full product row (metadata ensured) or null.
   ------------------------- */
export async function getProductById({ tenantId, companyId, productId }: { tenantId: string; companyId: string; productId: string }) {
  // try by id first
  const byIdSql = `SELECT * FROM public.hms_product WHERE id = $1 AND tenant_id = $2 LIMIT 1`;
  let r = await q(byIdSql, [productId, tenantId]);
  if (r.rowCount) {
    const p = r.rows[0];
    p.metadata = ensureObject(p.metadata);
    return p;
  }

  // fallback: try default_barcode or sku (if productId provided as barcode)
  const byBarcodeSql = `SELECT * FROM public.hms_product WHERE tenant_id = $1 AND company_id = $2 AND (default_barcode = $3 OR sku = $3) LIMIT 1`;
  r = await q(byBarcodeSql, [tenantId, companyId, productId]);
  if (!r.rowCount) return null;
  const p = r.rows[0];
  p.metadata = ensureObject(p.metadata);
  return p;
}

/* -------------------------
   NEW: listProductLedger
   - Returns ledger rows for a specific product, tenant+company scoped.
   - Supports limit/offset and optional q (search on batch_no/reference).
   ------------------------- */
type ListProductLedgerOpts = {
  tenantId: string;
  companyId: string;
  productId: string;
  limit?: number;
  offset?: number;
  q?: string | null;
};
export async function listProductLedger(opts: ListProductLedgerOpts) {
  const params: any[] = [];
  let where = ` WHERE sl.tenant_id = $1 AND sl.company_id = $2 AND sl.product_id = $3 `;
  params.push(opts.tenantId);
  params.push(opts.companyId);
  params.push(opts.productId);

  if (opts.q) {
    params.push(`%${opts.q}%`);
    params.push(`%${opts.q}%`);
    where += ` AND (b.batch_no ILIKE $${params.length-1} OR sl.reference ILIKE $${params.length}) `;
  }

  const limit = opts.limit ?? 200;
  const offset = opts.offset ?? 0;
  params.push(limit);
  params.push(offset);

  const sql = `
    SELECT sl.id, sl.tenant_id, sl.company_id, sl.product_id, p.sku, p.name AS product_name,
           sl.batch_id, b.batch_no, b.expiry_date,
           sl.location, sl.change_qty, sl.balance_qty, sl.movement_type, sl.reference, sl.cost, sl.created_at, sl.created_by, sl.metadata
    FROM public.hms_product_stock_ledger sl
    LEFT JOIN public.hms_product p ON p.id = sl.product_id
    LEFT JOIN public.hms_product_batch b ON b.id = sl.batch_id
    ${where}
    ORDER BY sl.created_at DESC
    LIMIT $${params.length-1} OFFSET $${params.length};
  `;
  const r = await q(sql, params);
  return r.rows.map((row: any) => { row.metadata = ensureObject(row.metadata); return row; });
}
