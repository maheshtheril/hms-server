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
// server/src/routes/hmsEncounters.ts
const express_1 = require("express");
const requireSession_1 = __importDefault(require("../middleware/requireSession"));
const idempotency_1 = __importStar(require("../middleware/idempotency"));
const svc = __importStar(require("../services/encountersService"));
const router = (0, express_1.Router)();
// POST / - create
router.post("/", requireSession_1.default, idempotency_1.default, async (req, res) => {
    try {
        const s = req.session;
        const b = req.body || {};
        if (!b.patient_id || !b.clinician_id)
            return res.status(400).json({ error: "patient_id and clinician_id required" });
        const payload = {
            tenantId: s.tenantId,
            companyId: s.companyId || null,
            patient_id: b.patient_id,
            clinician_id: b.clinician_id,
            appointment_id: b.appointment_id || null,
            started_at: b.started_at || null,
            ended_at: b.ended_at || null,
            reason: b.reason || null,
            notes: b.notes || null,
            createdBy: s.userId,
            source: b.source || "api",
            encounter_type: b.encounter_type ?? "visit",
        };
        const result = await svc.createEncounter(payload);
        if (result.error) {
            const status = result.error === "conflict" ? 409 : 500;
            await (0, idempotency_1.saveIdempotencyResponse)(req, res, status, result);
            return res.status(status).json(result);
        }
        await (0, idempotency_1.saveIdempotencyResponse)(req, res, 201, { encounter: result.encounter });
        return res.status(201).json({ encounter: result.encounter });
    }
    catch (err) {
        console.error("encounters.create", err);
        return res.status(500).json({ error: "server_error" });
    }
});
// GET /:id
router.get("/:id", requireSession_1.default, async (req, res) => {
    try {
        const s = req.session;
        const id = req.params.id;
        const enc = await svc.getEncounterById({ tenantId: s.tenantId, encounterId: id });
        if (!enc)
            return res.status(404).json({ error: "not_found" });
        return res.json(enc);
    }
    catch (err) {
        console.error("encounters.get", err);
        return res.status(500).json({ error: "server_error" });
    }
});
// GET / (list)
router.get("/", requireSession_1.default, async (req, res) => {
    try {
        const s = req.session;
        const { patient_id, clinician_id, from, to, status, limit } = req.query;
        const rows = await svc.listEncounters({
            tenantId: s.tenantId,
            patient_id,
            clinician_id,
            from,
            to,
            status,
            limit: limit ? parseInt(limit, 10) : 500,
        });
        return res.json({ data: rows });
    }
    catch (err) {
        console.error("encounters.list", err);
        return res.status(500).json({ error: "server_error" });
    }
});
// PUT /:id - update metadata and simple fields
router.put("/:id", requireSession_1.default, async (req, res) => {
    try {
        const s = req.session;
        const id = req.params.id;
        const { reason, notes, started_at, ended_at, appointment_id, clinician_id } = req.body;
        const r = await svc.updateEncounter({
            tenantId: s.tenantId,
            encounterId: id,
            reason,
            notes,
            started_at,
            ended_at,
            appointment_id,
            clinician_id,
        });
        if (r.error === "not_found")
            return res.status(404).json(r);
        if (r.error)
            return res.status(500).json(r);
        return res.json({ encounter: r.encounter });
    }
    catch (err) {
        console.error("encounters.update", err);
        return res.status(500).json({ error: "server_error" });
    }
});
// PUT /:id/close - close encounter (idempotent middleware handles responses)
router.put("/:id/close", requireSession_1.default, idempotency_1.default, async (req, res) => {
    try {
        const s = req.session;
        const encounterId = req.params.id;
        const { ended_at, outcome, notes } = req.body;
        const r = await svc.closeEncounter({
            tenantId: s.tenantId,
            encounterId,
            ended_at,
            outcome,
            notes,
            closedBy: s.userId,
        });
        if (r.error === "not_found") {
            await (0, idempotency_1.saveIdempotencyResponse)(req, res, 404, r);
            return res.status(404).json(r);
        }
        if (r.error) {
            await (0, idempotency_1.saveIdempotencyResponse)(req, res, 409, r);
            return res.status(409).json(r);
        }
        await (0, idempotency_1.saveIdempotencyResponse)(req, res, 200, { encounter: r.encounter });
        return res.json({ encounter: r.encounter });
    }
    catch (err) {
        console.error("encounters.close", err);
        return res.status(500).json({ error: "server_error" });
    }
});
// DELETE /:id
router.delete("/:id", requireSession_1.default, async (req, res) => {
    try {
        const s = req.session;
        const id = req.params.id;
        const r = await svc.deleteEncounter({ tenantId: s.tenantId, encounterId: id });
        if (r.error === "not_found")
            return res.status(404).json(r);
        if (r.error)
            return res.status(500).json(r);
        return res.json({ success: true });
    }
    catch (err) {
        console.error("encounters.delete", err);
        return res.status(500).json({ error: "server_error" });
    }
});
exports.default = router;
