"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// server/src/routes/hmsReceipts.ts
const express_1 = require("express");
const requireSession_1 = __importDefault(require("../middleware/requireSession"));
const express_validator_1 = require("express-validator");
const withTenantClient_1 = require("../db/withTenantClient");
const router = (0, express_1.Router)();
router.use(requireSession_1.default);
function getCtx(req) {
    if (!req.session || !req.session.tenant_id || !req.session.active_company_id)
        throw new Error("Missing session context");
    return { tenant_id: req.session.tenant_id, company_id: req.session.active_company_id, user_id: req.session.user_id || null };
}
/**
 * Create receipt (GRN) + lines (atomic). DB trigger will write stock ledger & upsert stock_levels.
 */
router.post("/", (0, express_validator_1.body)("lines").isArray({ min: 1 }), async (req, res) => {
    const v = (0, express_validator_1.validationResult)(req);
    if (!v.isEmpty())
        return res.status(400).json({ errors: v.array() });
    const ctx = getCtx(req);
    const { purchase_order_id = null, name = null, receipt_date = null, lines = [], notes = null } = req.body;
    try {
        const created = await (0, withTenantClient_1.withTenantClient)(ctx, async (client) => {
            const r = await client.query(`INSERT INTO public.hms_purchase_receipt
         (tenant_id, company_id, purchase_order_id, name, receipt_date, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [ctx.tenant_id, ctx.company_id, purchase_order_id, name, receipt_date || new Date(), notes, ctx.user_id || null]);
            const receipt = r.rows[0];
            for (const ln of lines) {
                if (!ln.product_id || !ln.qty)
                    throw { status: 400, message: "Invalid receipt line" };
                await client.query(`INSERT INTO public.hms_purchase_receipt_line
           (tenant_id, company_id, receipt_id, po_line_id, product_id, qty, uom, unit_price, batch_id, batch_no, location_id, lot_number, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [
                    ctx.tenant_id,
                    ctx.company_id,
                    receipt.id,
                    ln.po_line_id || null,
                    ln.product_id,
                    ln.qty,
                    ln.uom || null,
                    ln.unit_price ?? 0,
                    ln.batch_id || null,
                    ln.batch_no || null,
                    ln.location_id || null,
                    ln.lot_number || null,
                    ln.metadata ? JSON.stringify(ln.metadata) : "{}",
                ]);
            }
            // Recompute purchase_order status if referenced
            if (purchase_order_id) {
                // compute total PO qty & received via receipt lines connected to PO lines
                const poQtyRes = await client.query(`SELECT COALESCE(SUM(qty),0) AS po_qty FROM public.hms_purchase_order_line WHERE purchase_order_id = $1`, [purchase_order_id]);
                const poQty = Number(poQtyRes.rows[0].po_qty || 0);
                const recRes = await client.query(`SELECT COALESCE(SUM(prl.qty),0) AS received
           FROM public.hms_purchase_receipt_line prl
           JOIN public.hms_purchase_order_line pol ON pol.id = prl.po_line_id
           WHERE pol.purchase_order_id = $1`, [purchase_order_id]);
                const received = Number(recRes.rows[0].received || 0);
                let newStatus = "partially_received";
                if (poQty > 0 && received >= poQty)
                    newStatus = "received";
                await client.query(`UPDATE public.hms_purchase_order SET status = $1, updated_at = now() WHERE id = $2`, [newStatus, purchase_order_id]);
            }
            const createdReceipt = (await client.query(`SELECT * FROM public.hms_purchase_receipt WHERE id = $1`, [receipt.id])).rows[0];
            const createdLines = (await client.query(`SELECT * FROM public.hms_purchase_receipt_line WHERE receipt_id = $1`, [receipt.id])).rows;
            return { receipt: createdReceipt, lines: createdLines };
        });
        res.status(201).json(created);
    }
    catch (err) {
        console.error("POST /hms/receipts error:", err);
        if (err && err.status)
            return res.status(err.status).json({ error: err.message });
        res.status(500).json({ error: "Failed to create receipt" });
    }
});
exports.default = router;
