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
// server/src/routes/hmsAdmissions.ts
const express_1 = require("express");
const requireSession_1 = __importDefault(require("../middleware/requireSession"));
const idempotency_1 = __importStar(require("../middleware/idempotency"));
const svc = __importStar(require("../services/admissionsService"));
const db_1 = require("../db");
const router = (0, express_1.Router)();
/* POST / - create admission (idempotent) */
router.post("/", requireSession_1.default, idempotency_1.default, async (req, res) => {
    try {
        const s = req.session;
        const b = req.body || {};
        if (!b.patient_id)
            return res.status(400).json({ error: "patient_id required" });
        const r = await svc.createAdmission({
            tenantId: s.tenantId,
            companyId: s.companyId || null,
            patient_id: b.patient_id,
            encounter_id: b.encounter_id || null,
            admitted_at: b.admitted_at || null,
            ward: b.ward || null,
            bed: b.bed || null,
            admitting_doctor: b.admitting_doctor || null,
            status: b.status || "admitted",
            metadata: b.metadata || {},
            createdBy: s.userId,
        });
        if (r.error === "conflict") {
            await (0, idempotency_1.saveIdempotencyResponse)(req, res, 409, r);
            return res.status(409).json(r);
        }
        if (r.error) {
            await (0, idempotency_1.saveIdempotencyResponse)(req, res, 500, r);
            return res.status(500).json(r);
        }
        await (0, idempotency_1.saveIdempotencyResponse)(req, res, 201, { admission: r.admission });
        return res.status(201).json({ admission: r.admission });
    }
    catch (err) {
        console.error("admissions.create", err);
        return res.status(500).json({ error: "server_error" });
    }
});
/* GET / - list admissions */
router.get("/", requireSession_1.default, async (req, res) => {
    try {
        const s = req.session;
        const rows = await svc.listAdmissions({
            tenantId: s.tenantId,
            patient_id: req.query.patient_id,
            encounter_id: req.query.encounter_id,
            ward: req.query.ward,
            status: req.query.status,
            from: req.query.from,
            to: req.query.to,
            limit: req.query.limit ? parseInt(req.query.limit, 10) : 500,
        });
        return res.json({ data: rows });
    }
    catch (err) {
        console.error("admissions.list", err);
        return res.status(500).json({ error: "server_error" });
    }
});
/* GET /:id - detail */
router.get("/:id", requireSession_1.default, async (req, res) => {
    try {
        const s = req.session;
        const r = await svc.getAdmissionById({ tenantId: s.tenantId, admissionId: req.params.id });
        if (!r)
            return res.status(404).json({ error: "not_found" });
        return res.json(r);
    }
    catch (err) {
        console.error("admissions.get", err);
        return res.status(500).json({ error: "server_error" });
    }
});
/* PUT /:id - update */
router.put("/:id", requireSession_1.default, async (req, res) => {
    try {
        const s = req.session;
        const r = await svc.updateAdmission({
            tenantId: s.tenantId,
            admissionId: req.params.id,
            ...req.body,
        });
        if (r.error === "not_found")
            return res.status(404).json(r);
        if (r.error)
            return res.status(500).json(r);
        return res.json({ admission: r.admission });
    }
    catch (err) {
        console.error("admissions.update", err);
        return res.status(500).json({ error: "server_error" });
    }
});
/* PUT /:id/discharge - discharge (idempotent) */
router.put("/:id/discharge", requireSession_1.default, idempotency_1.default, async (req, res) => {
    try {
        const s = req.session;
        const { discharged_at, notes } = req.body;
        const r = await svc.dischargeAdmission({
            tenantId: s.tenantId,
            admissionId: req.params.id,
            discharged_at,
            dischargedBy: s.userId,
            notes,
        });
        if (r.error === "not_found") {
            await (0, idempotency_1.saveIdempotencyResponse)(req, res, 404, r);
            return res.status(404).json(r);
        }
        if (r.error) {
            await (0, idempotency_1.saveIdempotencyResponse)(req, res, 409, r);
            return res.status(409).json(r);
        }
        await (0, idempotency_1.saveIdempotencyResponse)(req, res, 200, { admission: r.admission });
        return res.json({ admission: r.admission });
    }
    catch (err) {
        console.error("admissions.discharge", err);
        return res.status(500).json({ error: "server_error" });
    }
});
/* DELETE /:id - delete */
router.delete("/:id", requireSession_1.default, async (req, res) => {
    try {
        const s = req.session;
        const r = await svc.deleteAdmission({ tenantId: s.tenantId, admissionId: req.params.id });
        if (r.error === "not_found")
            return res.status(404).json(r);
        if (r.error)
            return res.status(500).json(r);
        return res.json({ success: true });
    }
    catch (err) {
        console.error("admissions.delete", err);
        return res.status(500).json({ error: "server_error" });
    }
});
/* GET /beds/available?ward=...&bed=... - check availability */
router.get("/beds/available", requireSession_1.default, async (req, res) => {
    try {
        const s = req.session;
        const { ward, bed } = req.query;
        if (!ward || !bed)
            return res.status(400).json({ error: "ward_and_bed_required" });
        const sql = `
      SELECT 1 FROM public.hms_admission
      WHERE tenant_id=$1 AND ward=$2 AND bed=$3
        AND coalesce(status,'admitted')<>'discharged'
      LIMIT 1;
    `;
        const r = await (0, db_1.q)(sql, [s.tenantId, ward, bed]);
        return res.json({ available: r.rowCount === 0 });
    }
    catch (err) {
        console.error("admissions.beds.available", err);
        return res.status(500).json({ error: "server_error" });
    }
});
exports.default = router;
