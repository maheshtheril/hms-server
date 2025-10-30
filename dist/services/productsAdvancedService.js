"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.createBatch = createBatch;
exports.receiveGoods = receiveGoods;
exports.issueProduct = issueProduct;
exports.findBatchByBarcode = findBatchByBarcode;
exports.getProductStock = getProductStock;
exports.getUomConversion = getUomConversion;
exports.getProductById = getProductById;
exports.listProductLedger = listProductLedger;
// server/src/services/productsAdvancedService.ts
// when getClient is the default export and q is named
const dbCompat_1 = __importStar(require("../dbCompat"));
/**
 * Advanced product service: batches, FIFO consumption by batch & expiry, barcode lookup, UOM conversions.
 * - Assumes migrations for hms_product_batch, batch_id in stock ledger, uom conversion exist.
 * - All operations are tenant+company scoped.
 */
function ensureObject(v) {
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}
/* -------------------------
   Core helpers
   ------------------------- */
async function getBatchesForConsumption(client, tenantId, companyId, productId, allowExpired = false) {
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
    const rows = r.rows.filter((row) => {
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
async function createBatch(payload) {
    const client = await (0, dbCompat_1.default)();
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
            await client.query(`INSERT INTO public.hms_product_stock_ledger (tenant_id, company_id, product_id, location, change_qty, balance_qty, movement_type, reference, cost, created_at, created_by, batch_id, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now(), $10, $11, '{}'::jsonb)`, [payload.tenantId, payload.companyId, payload.productId, null, openingQty, newBal, "opening", "batch_create_opening", payload.cost ?? null, payload.createdBy ?? null, batch.id]);
        }
        await client.query("COMMIT");
        batch.metadata = ensureObject(batch.metadata);
        return { batch };
    }
    catch (err) {
        await client.query("ROLLBACK");
        console.error("productsAdvancedService.createBatch", err);
        return { error: "server_error", detail: err?.message };
    }
    finally {
        try {
            client.release();
        }
        catch { }
    }
}
/* -------------------------
   Receive (GRN) — create batch if needed + ledger row
   ------------------------- */
async function receiveGoods(payload) {
    const client = await (0, dbCompat_1.default)();
    try {
        await client.query("BEGIN");
        // If batch_no provided, upsert batch; otherwise create generated batch_no (timestamp)
        const batchNo = payload.batch_no ?? `B-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        // create or update batch (no opening qty — we'll record ledger separately)
        const batchRes = await client.query(`INSERT INTO public.hms_product_batch (tenant_id, company_id, product_id, batch_no, expiry_date, mrp, cost, created_at, created_by, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now(), $8, '{}'::jsonb)
       ON CONFLICT (tenant_id, company_id, product_id, batch_no)
       DO UPDATE SET expiry_date = EXCLUDED.expiry_date, mrp = EXCLUDED.mrp, cost = EXCLUDED.cost
       RETURNING *;`, [payload.tenantId, payload.companyId, payload.productId, batchNo, payload.expiry_date ?? null, payload.mrp ?? null, payload.cost ?? null, payload.createdBy ?? null]);
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
    }
    catch (err) {
        await client.query("ROLLBACK");
        console.error("productsAdvancedService.receiveGoods", err);
        return { error: "server_error", detail: err?.message };
    }
    finally {
        try {
            client.release();
        }
        catch { }
    }
}
/* -------------------------
   Issue (consume) — FIFO by expiry_date then created_at
   ------------------------- */
async function issueProduct(payload) {
    const client = await (0, dbCompat_1.default)();
    try {
        await client.query("BEGIN");
        let remaining = Number(payload.qty);
        if (remaining <= 0) {
            await client.query("ROLLBACK");
            return { error: "invalid_qty" };
        }
        // If user selected specific batch, consume from that only
        const consumed = [];
        if (payload.consumeStrategy === "batch_select" && payload.selected_batch_id) {
            // lock batch ledger
            const sumRes = await client.query(`SELECT COALESCE(SUM(change_qty),0)::numeric(16,6) AS cur FROM public.hms_product_stock_ledger WHERE batch_id = $1 FOR UPDATE`, [payload.selected_batch_id]);
            const cur = Number(sumRes.rows[0]?.cur ?? 0);
            const take = Math.min(remaining, cur);
            if (take <= 0) {
                await client.query("ROLLBACK");
                return { error: "batch_empty" };
            }
            const newBal = cur - take;
            const insert = await client.query(`INSERT INTO public.hms_product_stock_ledger (tenant_id, company_id, product_id, location, change_qty, balance_qty, movement_type, reference, cost, created_at, created_by, batch_id, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now(), $10, $11, '{}'::jsonb) RETURNING *;`, [payload.tenantId, payload.companyId, payload.productId, payload.location ?? null, -take, newBal, "issue", payload.reference ?? null, null, payload.createdBy ?? null, payload.selected_batch_id]);
            // update batch.qty_on_hand
            await client.query(`UPDATE public.hms_product_batch SET qty_on_hand = $1 WHERE id = $2`, [newBal, payload.selected_batch_id]);
            consumed.push(insert.rows[0]);
            remaining -= take;
        }
        else {
            // default: FIFO by expiry (soonest expiry first), then by created_at
            const batches = await getBatchesForConsumption(client, payload.tenantId, payload.companyId, payload.productId, /*allowExpired=*/ false);
            for (const b of batches) {
                if (remaining <= 0)
                    break;
                const avail = Number(b.qty);
                if (avail <= 0)
                    continue;
                const take = Math.min(avail, remaining);
                // insert negative ledger row referencing batch
                const curSum = await client.query(`SELECT COALESCE(SUM(change_qty),0)::numeric(16,6) AS cur FROM public.hms_product_stock_ledger WHERE batch_id = $1 FOR UPDATE`, [b.id]);
                const cur = Number(curSum.rows[0]?.cur ?? 0);
                const newBal = cur - take;
                const insert = await client.query(`INSERT INTO public.hms_product_stock_ledger (tenant_id, company_id, product_id, location, change_qty, balance_qty, movement_type, reference, cost, created_at, created_by, batch_id, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now(), $10, $11, '{}'::jsonb) RETURNING *;`, [payload.tenantId, payload.companyId, payload.productId, payload.location ?? null, -take, newBal, "issue", payload.reference ?? null, b.cost ?? null, payload.createdBy ?? null, b.id]);
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
    }
    catch (err) {
        await client.query("ROLLBACK");
        console.error("productsAdvancedService.issueProduct", err);
        return { error: "server_error", detail: err?.message };
    }
    finally {
        try {
            client.release();
        }
        catch { }
    }
}
/* -------------------------
   Barcode lookup helpers
   ------------------------- */
async function findBatchByBarcode({ tenantId, companyId, barcode }) {
    const sql = `
    SELECT * FROM public.hms_product_batch
    WHERE tenant_id = $1 AND company_id = $2 AND (vendor_barcode = $3 OR internal_barcode = $3)
    LIMIT 1;
  `;
    const r = await (0, dbCompat_1.q)(sql, [tenantId, companyId, barcode]);
    if (!r.rowCount)
        return null;
    const b = r.rows[0];
    b.metadata = ensureObject(b.metadata);
    return b;
}
/* -------------------------
   Utility: get current stock by product (all batches)
   ------------------------- */
async function getProductStock({ tenantId, companyId, productId }) {
    // aggregate ledger
    const sql = `SELECT COALESCE(SUM(change_qty),0)::numeric(16,6) AS qty FROM public.hms_product_stock_ledger WHERE product_id = $1 AND tenant_id = $2 AND company_id = $3`;
    const r = await (0, dbCompat_1.q)(sql, [productId, tenantId, companyId]);
    const qty = Number(r.rows[0]?.qty ?? 0);
    // also list batch level qtys
    const batchesRes = await (0, dbCompat_1.q)(`SELECT b.id, b.batch_no, b.expiry_date, b.mrp, b.cost, COALESCE(SUM(sl.change_qty),0)::numeric(16,6) AS qty
     FROM public.hms_product_batch b
     LEFT JOIN public.hms_product_stock_ledger sl ON sl.batch_id = b.id
     WHERE b.product_id = $1 AND b.tenant_id = $2 AND b.company_id = $3
     GROUP BY b.id, b.batch_no, b.expiry_date, b.mrp, b.cost
     ORDER BY b.expiry_date ASC NULLS LAST`, [productId, tenantId, companyId]);
    return { qty, batches: batchesRes.rows.map((r) => ({ ...r, qty: Number(r.qty) })) };
}
/* -------------------------
   UOM conversion helpers
   ------------------------- */
async function getUomConversion({ tenantId, companyId, productId, from_uom, to_uom }) {
    const r = await (0, dbCompat_1.q)(`SELECT factor FROM public.hms_product_uom_conversion WHERE product_id=$1 AND tenant_id=$2 AND company_id=$3 AND from_uom=$4 AND to_uom=$5 LIMIT 1`, [productId, tenantId, companyId, from_uom, to_uom]);
    if (!r.rowCount)
        return null;
    return Number(r.rows[0].factor);
}
/* -------------------------
   NEW: getProductById
   - Accepts productId that may be an actual id OR a barcode. Tries id first, then fallback to default_barcode lookup.
   - Returns full product row (metadata ensured) or null.
   ------------------------- */
async function getProductById({ tenantId, companyId, productId }) {
    // try by id first
    const byIdSql = `SELECT * FROM public.hms_product WHERE id = $1 AND tenant_id = $2 LIMIT 1`;
    let r = await (0, dbCompat_1.q)(byIdSql, [productId, tenantId]);
    if (r.rowCount) {
        const p = r.rows[0];
        p.metadata = ensureObject(p.metadata);
        return p;
    }
    // fallback: try default_barcode or sku (if productId provided as barcode)
    const byBarcodeSql = `SELECT * FROM public.hms_product WHERE tenant_id = $1 AND company_id = $2 AND (default_barcode = $3 OR sku = $3) LIMIT 1`;
    r = await (0, dbCompat_1.q)(byBarcodeSql, [tenantId, companyId, productId]);
    if (!r.rowCount)
        return null;
    const p = r.rows[0];
    p.metadata = ensureObject(p.metadata);
    return p;
}
async function listProductLedger(opts) {
    const params = [];
    let where = ` WHERE sl.tenant_id = $1 AND sl.company_id = $2 AND sl.product_id = $3 `;
    params.push(opts.tenantId);
    params.push(opts.companyId);
    params.push(opts.productId);
    if (opts.q) {
        params.push(`%${opts.q}%`);
        params.push(`%${opts.q}%`);
        where += ` AND (b.batch_no ILIKE $${params.length - 1} OR sl.reference ILIKE $${params.length}) `;
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
    LIMIT $${params.length - 1} OFFSET $${params.length};
  `;
    const r = await (0, dbCompat_1.q)(sql, params);
    return r.rows.map((row) => { row.metadata = ensureObject(row.metadata); return row; });
}
