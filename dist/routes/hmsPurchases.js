"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// server/src/routes/hmsPurchases.ts
const express_1 = require("express");
const requireSession_1 = __importDefault(require("../middleware/requireSession"));
const express_validator_1 = require("express-validator");
const withTenantClient_1 = require("../db/withTenantClient");
const router = (0, express_1.Router)();
router.use(requireSession_1.default);
function getCtx(req) {
    if (!req.session || !req.session.tenant_id || !req.session.active_company_id) {
        throw new Error("Missing session context");
    }
    return {
        tenant_id: req.session.tenant_id,
        company_id: req.session.active_company_id,
        user_id: req.session.user_id || null,
    };
}
/* -------------------- List POs (paginated) -------------------- */
router.get("/", async (req, res) => {
    try {
        const ctx = getCtx(req);
        const limit = Math.min(100, Number(req.query.limit || 50));
        const offset = Number(req.query.offset || 0);
        const rows = await (0, withTenantClient_1.withTenantClient)(ctx, async (client) => {
            const { rows } = await client.query(`SELECT p.*, s.name AS supplier_name
         FROM public.hms_purchase_order p
         LEFT JOIN public.hms_supplier s ON s.id = p.supplier_id
         WHERE p.tenant_id = $1 AND p.company_id = $2
         ORDER BY p.created_at DESC
         LIMIT $3 OFFSET $4`, [ctx.tenant_id, ctx.company_id, limit, offset]);
            return rows;
        });
        res.json(rows);
    }
    catch (err) {
        console.error("GET /hms/purchases error:", err);
        res.status(500).json({ error: "Failed to list purchase orders" });
    }
});
/* -------------------- Create PO (atomic) -------------------- */
router.post("/", (0, express_validator_1.body)("name").isString().notEmpty(), (0, express_validator_1.body)("supplier_id").isUUID(), (0, express_validator_1.body)("lines").isArray({ min: 1 }), async (req, res) => {
    const v = (0, express_validator_1.validationResult)(req);
    if (!v.isEmpty())
        return res.status(400).json({ errors: v.array() });
    const ctx = getCtx(req);
    const { name, supplier_id, order_date, expected_date, currency, notes = null, lines } = req.body;
    try {
        const result = await (0, withTenantClient_1.withTenantClient)(ctx, async (client) => {
            // create PO
            const poIns = await client.query(`INSERT INTO public.hms_purchase_order
           (tenant_id, company_id, name, supplier_id, order_date, expected_date, currency, notes, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           RETURNING *`, [ctx.tenant_id, ctx.company_id, name, supplier_id, order_date || new Date(), expected_date || null, currency || "USD", notes || null, ctx.user_id || null]);
            const po = poIns.rows[0];
            let subtotal = 0;
            let totalTax = 0;
            // insert lines
            for (let i = 0; i < lines.length; i++) {
                const ln = lines[i];
                if (!ln.product_id || !ln.qty)
                    throw { status: 400, message: "Invalid line: missing product_id or qty" };
                const line_no = (i + 1) * 10;
                const line_total = Number(ln.line_total ?? (ln.qty * ln.unit_price || 0));
                const tax_amount = Number(ln.tax_amount ?? 0);
                const inserted = await client.query(`INSERT INTO public.hms_purchase_order_line
             (tenant_id, company_id, purchase_order_id, line_no, product_id, product_name, description,
              qty, uom, unit_price, discount_percent, tax, tax_amount, line_total, batch_no, metadata)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
             RETURNING *`, [
                    ctx.tenant_id,
                    ctx.company_id,
                    po.id,
                    line_no,
                    ln.product_id,
                    ln.product_name || "Unknown",
                    ln.description || null,
                    ln.qty,
                    ln.uom || null,
                    ln.unit_price ?? 0,
                    ln.discount_percent ?? 0,
                    JSON.stringify(ln.tax || {}),
                    tax_amount,
                    line_total,
                    ln.batch_no || null,
                    ln.metadata ? JSON.stringify(ln.metadata) : "{}",
                ]);
                subtotal += Number(line_total);
                totalTax += Number(tax_amount);
            }
            // update totals
            await client.query(`UPDATE public.hms_purchase_order
           SET subtotal = $1, total_tax = $2, total_amount = $3, updated_at = now()
           WHERE id = $4`, [subtotal, totalTax, subtotal + totalTax, po.id]);
            const poFull = (await client.query(`SELECT * FROM public.hms_purchase_order WHERE id = $1`, [po.id])).rows[0];
            const poLines = (await client.query(`SELECT * FROM public.hms_purchase_order_line WHERE purchase_order_id = $1 ORDER BY line_no`, [po.id])).rows;
            return { purchase_order: poFull, lines: poLines };
        });
        res.status(201).json(result);
    }
    catch (err) {
        console.error("POST /hms/purchases error:", err);
        if (err && err.status)
            return res.status(err.status).json({ error: err.message });
        res.status(500).json({ error: "Failed to create purchase order" });
    }
});
/* -------------------- Get single PO (with lines) -------------------- */
router.get("/:id", (0, express_validator_1.param)("id").isUUID(), async (req, res) => {
    const v = (0, express_validator_1.validationResult)(req);
    if (!v.isEmpty())
        return res.status(400).json({ errors: v.array() });
    try {
        const ctx = getCtx(req);
        const id = req.params.id;
        const { purchase_order, lines } = await (0, withTenantClient_1.withTenantClient)(ctx, async (client) => {
            const poRes = await client.query(`SELECT p.*, s.name as supplier_name FROM public.hms_purchase_order p
         LEFT JOIN public.hms_supplier s ON s.id = p.supplier_id
         WHERE p.id = $1 AND p.tenant_id = $2 AND p.company_id = $3`, [id, ctx.tenant_id, ctx.company_id]);
            if (!poRes.rows.length)
                throw { status: 404, message: "Purchase order not found" };
            const linesRes = await client.query(`SELECT * FROM public.hms_purchase_order_line WHERE purchase_order_id = $1 ORDER BY line_no`, [id]);
            return { purchase_order: poRes.rows[0], lines: linesRes.rows };
        });
        res.json({ purchase_order, lines });
    }
    catch (err) {
        console.error("GET /hms/purchases/:id error:", err);
        if (err && err.status)
            return res.status(err.status).json({ error: err.message });
        res.status(500).json({ error: "Failed to fetch purchase order" });
    }
});
/* -------------------- Update PO (patch) -------------------- */
router.put("/:id", (0, express_validator_1.param)("id").isUUID(), async (req, res) => {
    try {
        const ctx = getCtx(req);
        const id = req.params.id;
        const payload = req.body;
        const updated = await (0, withTenantClient_1.withTenantClient)(ctx, async (client) => {
            const poRes = await client.query(`SELECT * FROM public.hms_purchase_order WHERE id = $1 AND tenant_id = $2 AND company_id = $3`, [id, ctx.tenant_id, ctx.company_id]);
            if (!poRes.rows.length)
                throw { status: 404, message: "PO not found" };
            const po = poRes.rows[0];
            if (["approved", "partially_received", "received", "closed", "cancelled"].includes(po.status)) {
                throw { status: 400, message: "Cannot modify PO in its current status" };
            }
            const up = [];
            const params = [];
            let idx = 1;
            if (payload.expected_date !== undefined) {
                up.push(`expected_date = $${idx++}`);
                params.push(payload.expected_date);
            }
            if (payload.notes !== undefined) {
                up.push(`notes = $${idx++}`);
                params.push(payload.notes);
            }
            if (payload.name) {
                up.push(`name = $${idx++}`);
                params.push(payload.name);
            }
            if (payload.supplier_id) {
                up.push(`supplier_id = $${idx++}`);
                params.push(payload.supplier_id);
            }
            if (up.length === 0)
                throw { status: 400, message: "Nothing to update" };
            params.push(id, ctx.tenant_id, ctx.company_id);
            const sql = `UPDATE public.hms_purchase_order SET ${up.join(", ")}, updated_at = now() WHERE id = $${idx++} AND tenant_id = $${idx++} AND company_id = $${idx++} RETURNING *`;
            const u = await client.query(sql, params);
            return u.rows[0];
        });
        res.json(updated);
    }
    catch (err) {
        console.error("PUT /hms/purchases/:id error:", err);
        if (err && err.status)
            return res.status(err.status).json({ error: err.message });
        res.status(500).json({ error: "Failed to update PO" });
    }
});
/* -------------------- Change status -------------------- */
router.put("/:id/status", (0, express_validator_1.param)("id").isUUID(), (0, express_validator_1.body)("status").isString(), async (req, res) => {
    const v = (0, express_validator_1.validationResult)(req);
    if (!v.isEmpty())
        return res.status(400).json({ errors: v.array() });
    try {
        const ctx = getCtx(req);
        const id = req.params.id;
        const { status } = req.body;
        const result = await (0, withTenantClient_1.withTenantClient)(ctx, async (client) => {
            const poRes = await client.query(`SELECT id, status FROM public.hms_purchase_order WHERE id = $1 AND tenant_id = $2 AND company_id = $3`, [id, ctx.tenant_id, ctx.company_id]);
            if (!poRes.rows.length)
                throw { status: 404, message: "PO not found" };
            const current = poRes.rows[0].status;
            const allowedTransitions = {
                draft: ["confirmed", "cancelled"],
                confirmed: ["approved", "cancelled"],
                approved: ["partially_received", "received", "cancelled"],
                partially_received: ["received", "closed", "cancelled"],
                received: ["closed", "cancelled"],
                billed: ["closed"],
                closed: [],
                cancelled: [],
            };
            if (!allowedTransitions[current] || !allowedTransitions[current].includes(status)) {
                throw { status: 400, message: `Invalid status transition from ${current} -> ${status}` };
            }
            await client.query(`UPDATE public.hms_purchase_order SET status = $1, updated_at = now() WHERE id = $2`, [status, id]);
            return { id, status };
        });
        res.json(result);
    }
    catch (err) {
        console.error("PUT /hms/purchases/:id/status error:", err);
        if (err && err.status)
            return res.status(err.status).json({ error: err.message });
        res.status(500).json({ error: "Failed to update status" });
    }
});
/* -------------------- Delete PO (soft delete conventions vary) -------------------- */
router.delete("/:id", (0, express_validator_1.param)("id").isUUID(), async (req, res) => {
    try {
        const ctx = getCtx(req);
        const id = req.params.id;
        await (0, withTenantClient_1.withTenantClient)(ctx, async (client) => {
            const poRes = await client.query(`SELECT status FROM public.hms_purchase_order WHERE id = $1 AND tenant_id = $2 AND company_id = $3`, [id, ctx.tenant_id, ctx.company_id]);
            if (!poRes.rows.length)
                throw { status: 404, message: "PO not found" };
            if (poRes.rows[0].status !== "draft")
                throw { status: 400, message: "Only draft POs can be deleted" };
            await client.query(`DELETE FROM public.hms_purchase_order_line WHERE purchase_order_id = $1`, [id]);
            await client.query(`DELETE FROM public.hms_purchase_order WHERE id = $1`, [id]);
            return { ok: true };
        });
        res.json({ ok: true });
    }
    catch (err) {
        console.error("DELETE /hms/purchases/:id error:", err);
        if (err && err.status)
            return res.status(err.status).json({ error: err.message });
        res.status(500).json({ error: "Failed to delete PO" });
    }
});
exports.default = router;
