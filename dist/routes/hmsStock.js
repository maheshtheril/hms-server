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
// server/src/routes/hmsStock.ts
const express_1 = require("express");
const requireSession_1 = __importDefault(require("../middleware/requireSession"));
const svc = __importStar(require("../services/stockService"));
const router = (0, express_1.Router)();
/**
 * GET /hms/stock
 * Query:
 *  company_id (required),
 *  product_id, batch_id, movement_type, reference, from, to, q, limit, offset
 */
router.get("/", requireSession_1.default, async (req, res) => {
    try {
        const s = req.session;
        const qParams = req.query || {};
        const companyId = qParams.company_id;
        if (!companyId)
            return res.status(400).json({ error: "company_id_required" });
        const rows = await svc.listStockLedger({
            tenantId: s.tenantId,
            companyId,
            product_id: qParams.product_id ?? null,
            batch_id: qParams.batch_id ?? null,
            movement_type: qParams.movement_type ?? null,
            reference: qParams.reference ?? null,
            from: qParams.from ?? null,
            to: qParams.to ?? null,
            q: qParams.q ?? null,
            limit: qParams.limit ? parseInt(qParams.limit, 10) : undefined,
            offset: qParams.offset ? parseInt(qParams.offset, 10) : undefined,
        });
        return res.json({ data: rows });
    }
    catch (err) {
        console.error("stock.list", err);
        return res.status(500).json({ error: "server_error" });
    }
});
/**
 * GET /hms/stock/summary
 * Query: company_id (required), q, limit, offset
 * Returns aggregated qty per product
 */
router.get("/summary", requireSession_1.default, async (req, res) => {
    try {
        const s = req.session;
        const companyId = req.query.company_id;
        if (!companyId)
            return res.status(400).json({ error: "company_id_required" });
        const rows = await svc.summarizeStockByProduct({
            tenantId: s.tenantId,
            companyId,
            q: req.query.q ?? null,
            limit: req.query.limit ? parseInt(req.query.limit, 10) : undefined,
            offset: req.query.offset ? parseInt(req.query.offset, 10) : undefined,
        });
        return res.json({ data: rows });
    }
    catch (err) {
        console.error("stock.summary", err);
        return res.status(500).json({ error: "server_error" });
    }
});
/**
 * GET /hms/stock/export
 * Query same as GET / (company_id required)
 * Returns CSV content
 */
router.get("/export", requireSession_1.default, async (req, res) => {
    try {
        const s = req.session;
        const qParams = req.query || {};
        const companyId = qParams.company_id;
        if (!companyId)
            return res.status(400).json({ error: "company_id_required" });
        const csv = await svc.exportLedgerCsv({
            tenantId: s.tenantId,
            companyId,
            product_id: qParams.product_id ?? null,
            batch_id: qParams.batch_id ?? null,
            movement_type: qParams.movement_type ?? null,
            reference: qParams.reference ?? null,
            from: qParams.from ?? null,
            to: qParams.to ?? null,
            q: qParams.q ?? null,
            limit: qParams.limit ? parseInt(qParams.limit, 10) : 10000,
            offset: qParams.offset ? parseInt(qParams.offset, 10) : 0,
        });
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="stock_ledger_${Date.now()}.csv"`);
        return res.send(csv);
    }
    catch (err) {
        console.error("stock.export", err);
        return res.status(500).json({ error: "server_error" });
    }
});
exports.default = router;
