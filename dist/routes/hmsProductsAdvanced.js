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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// server/src/routes/hmsProductsAdvanced.ts
const express_1 = require("express");
const requireSession_1 = __importDefault(require("../middleware/requireSession"));
const svc = __importStar(require("../services/productsAdvancedService"));
const router = (0, express_1.Router)();
/* Create batch */
router.post("/batches", requireSession_1.default, async (req, res) => {
    try {
        const s = req.session;
        const b = req.body || {};
        if (!b.product_id || !b.company_id || !b.batch_no)
            return res.status(400).json({ error: "product_id_company_id_batch_no_required" });
        const r = await svc.createBatch({
            tenantId: s.tenantId,
            companyId: b.company_id,
            productId: b.product_id,
            batch_no: b.batch_no,
            expiry_date: b.expiry_date || null,
            mrp: b.mrp ?? null,
            cost: b.cost ?? null,
            qty: b.qty ?? 0,
            vendor_barcode: b.vendor_barcode ?? null,
            internal_barcode: b.internal_barcode ?? null,
            createdBy: s.userId,
            metadata: b.metadata || {},
        });
        if (r.error)
            return res.status(500).json(r);
        return res.status(201).json({ batch: r.batch });
    }
    catch (err) {
        console.error("products.batches.create", err);
        return res.status(500).json({ error: "server_error" });
    }
});
/* Receive goods (purchase GRN) */
router.post("/receive", requireSession_1.default, async (req, res) => {
    try {
        const s = req.session;
        const b = req.body || {};
        if (!b.product_id || !b.company_id || b.qty === undefined)
            return res.status(400).json({ error: "product_id_company_id_qty_required" });
        const r = await svc.receiveGoods({
            tenantId: s.tenantId,
            companyId: b.company_id,
            productId: b.product_id,
            batch_no: b.batch_no || undefined,
            expiry_date: b.expiry_date || undefined,
            mrp: b.mrp !== undefined ? Number(b.mrp) : undefined,
            cost: b.cost !== undefined ? Number(b.cost) : undefined,
            qty: Number(b.qty),
            location: b.location || null,
            reference: b.reference || null,
            createdBy: s.userId,
            metadata: b.metadata || {},
        });
        if (r.error)
            return res.status(500).json(r);
        return res.status(201).json(r);
    }
    catch (err) {
        console.error("products.receive", err);
        return res.status(500).json({ error: "server_error" });
    }
});
/* Issue (sell/consume) */
router.post("/:id/issue", requireSession_1.default, async (req, res) => {
    try {
        const s = req.session;
        const productId = req.params.id;
        const b = req.body || {};
        if (b.qty === undefined || !b.company_id)
            return res.status(400).json({ error: "qty_and_company_id_required" });
        const r = await svc.issueProduct({
            tenantId: s.tenantId,
            companyId: b.company_id,
            productId,
            qty: Number(b.qty),
            location: b.location || null,
            reference: b.reference || null,
            createdBy: s.userId,
            consumeStrategy: b.consumeStrategy || "fifo",
            selected_batch_id: b.selected_batch_id || null,
        });
        if (r.error) {
            if (r.error === "insufficient_stock")
                return res.status(409).json(r);
            return res.status(500).json(r);
        }
        return res.json(r);
    }
    catch (err) {
        console.error("products.issue", err);
        return res.status(500).json({ error: "server_error" });
    }
});
/* Barcode lookup -> return batch or product */
router.get("/barcode/lookup", requireSession_1.default, async (req, res) => {
    try {
        const s = req.session;
        const { company_id, barcode } = req.query;
        if (!company_id || !barcode)
            return res.status(400).json({ error: "company_id_and_barcode_required" });
        const batch = await svc.findBatchByBarcode({ tenantId: s.tenantId, companyId: company_id, barcode: String(barcode) });
        if (batch)
            return res.json({ type: "batch", batch });
        // fallback: try product default barcode
        // note: cast svc to any to avoid TS error if the function is not declared in the service types
        const p = await svc.getProductById({ tenantId: s.tenantId, companyId: company_id, productId: String(barcode) }).catch(() => null);
        if (p)
            return res.json({ type: "product", product: p });
        return res.status(404).json({ error: "not_found" });
    }
    catch (err) {
        console.error("products.barcode.lookup", err);
        return res.status(500).json({ error: "server_error" });
    }
});
/* Get product stock with batches */
router.get("/:id/stock", requireSession_1.default, async (req, res) => {
    try {
        const s = req.session;
        const { company_id } = req.query;
        if (!company_id)
            return res.status(400).json({ error: "company_id_required" });
        const r = await svc.getProductStock({ tenantId: s.tenantId, companyId: company_id, productId: req.params.id });
        return res.json(r);
    }
    catch (err) {
        console.error("products.stock", err);
        return res.status(500).json({ error: "server_error" });
    }
});
/* List ledger for product */
router.get("/:id/ledger", requireSession_1.default, async (req, res) => {
    try {
        const s = req.session;
        const { company_id, limit } = req.query;
        if (!company_id)
            return res.status(400).json({ error: "company_id_required" });
        // cast svc to any at callsite to avoid TS complaining if the service's type doesn't declare listProductLedger
        const rows = await svc.listProductLedger({
            tenantId: s.tenantId,
            companyId: company_id,
            productId: req.params.id,
            limit: limit ? parseInt(limit, 10) : 200
        });
        return res.json({ data: rows });
    }
    catch (err) {
        console.error("products.ledger", err);
        return res.status(500).json({ error: "server_error" });
    }
});
exports.default = router;
