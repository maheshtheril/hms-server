"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listStockLedger = listStockLedger;
exports.summarizeStockByProduct = summarizeStockByProduct;
exports.exportLedgerCsv = exportLedgerCsv;
// server/src/services/stockService.ts
const db_1 = require("../db");
/**
 * stockService
 * - listStockLedger: returns ledger rows with product/batch info
 * - summarizeStockByProduct: aggregated qty per product
 * - exportLedgerCsv: returns CSV string for the filtered rows
 *
 * All methods enforce tenant + company scoping.
 */
function ensureObject(v) {
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}
async function listStockLedger(opts) {
    const params = [];
    let where = ` WHERE sl.tenant_id = $1 AND sl.company_id = $2 `;
    params.push(opts.tenantId);
    params.push(opts.companyId);
    if (opts.product_id) {
        params.push(opts.product_id);
        where += ` AND sl.product_id = $${params.length} `;
    }
    if (opts.batch_id) {
        params.push(opts.batch_id);
        where += ` AND sl.batch_id = $${params.length} `;
    }
    if (opts.movement_type) {
        params.push(opts.movement_type);
        where += ` AND sl.movement_type = $${params.length} `;
    }
    if (opts.reference) {
        params.push(opts.reference);
        where += ` AND sl.reference = $${params.length} `;
    }
    if (opts.from) {
        params.push(opts.from);
        where += ` AND sl.created_at >= $${params.length} `;
    }
    if (opts.to) {
        params.push(opts.to);
        where += ` AND sl.created_at <= $${params.length} `;
    }
    // full-text-ish search across product sku/name and batch_no/reference
    if (opts.q) {
        params.push(`%${opts.q}%`);
        params.push(`%${opts.q}%`);
        params.push(`%${opts.q}%`);
        where += ` AND (p.sku ILIKE $${params.length - 2} OR p.name ILIKE $${params.length - 1} OR b.batch_no ILIKE $${params.length}) `;
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
    const r = await (0, db_1.q)(sql, params);
    return r.rows.map((row) => { row.metadata = ensureObject(row.metadata); return row; });
}
async function summarizeStockByProduct(opts) {
    const params = [];
    let where = ` WHERE sl.tenant_id = $1 AND sl.company_id = $2 `;
    params.push(opts.tenantId);
    params.push(opts.companyId);
    if (opts.q) {
        params.push(`%${opts.q}%`);
        params.push(`%${opts.q}%`);
        where += ` AND (p.sku ILIKE $${params.length - 1} OR p.name ILIKE $${params.length}) `;
    }
    const limit = opts.limit ?? 200;
    const offset = opts.offset ?? 0;
    params.push(limit);
    params.push(offset);
    const sql = `
    SELECT p.id AS product_id, p.sku, p.name, COALESCE(SUM(sl.change_qty),0)::numeric(16,6) AS qty
    FROM public.hms_product p
    LEFT JOIN public.hms_product_stock_ledger sl ON sl.product_id = p.id AND sl.tenant_id = $1 AND sl.company_id = $2
    ${where.replace(` WHERE sl.tenant_id = $1 AND sl.company_id = $2 `, "")}
    GROUP BY p.id, p.sku, p.name
    ORDER BY p.name ASC
    LIMIT $${params.length - 1} OFFSET $${params.length};
  `;
    const r = await (0, db_1.q)(sql, params);
    return r.rows.map((row) => ({ ...row, qty: Number(row.qty) }));
}
/* CSV export for ledger rows (simple, server-side generated) */
async function exportLedgerCsv(opts) {
    const rows = await listStockLedger(opts);
    // header
    const header = ["created_at", "product_id", "sku", "product_name", "batch_id", "batch_no", "expiry_date", "movement_type", "reference", "change_qty", "balance_qty", "cost", "location", "created_by"];
    // build CSV string (comma separated, naive escaping)
    const escape = (v) => {
        if (v === null || v === undefined)
            return "";
        const s = String(v);
        return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [header.join(",")];
    for (const r of rows) {
        lines.push([
            r.created_at?.toISOString?.() ?? r.created_at,
            r.product_id,
            r.sku ?? "",
            r.product_name ?? "",
            r.batch_id ?? "",
            r.batch_no ?? "",
            r.expiry_date ? (new Date(r.expiry_date).toISOString().slice(0, 10)) : "",
            r.movement_type ?? "",
            r.reference ?? "",
            String(r.change_qty ?? ""),
            String(r.balance_qty ?? ""),
            r.cost ?? "",
            r.location ?? "",
            r.created_by ?? ""
        ].map(escape).join(","));
    }
    return lines.join("\n");
}
