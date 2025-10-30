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
// server/src/routes/hmsAppointments.ts
const express_1 = require("express");
const zod_1 = require("zod");
const requireSession_1 = __importDefault(require("../middleware/requireSession"));
const idempotency_1 = __importStar(require("../middleware/idempotency"));
const svc = __importStar(require("../services/appointmentsService"));
const asyncHandler_1 = __importDefault(require("../utils/asyncHandler")); // small wrapper: (fn) => (req,res,next) => fn(req,res,next).catch(next)
const validators_1 = require("../utils/validators"); // optional helper, fallback included below
const logger_1 = __importDefault(require("../lib/logger")); // optional - replace with console if you don't have a logger
/* -------------------------------------------------------------------------- */
/*                              Helpers / Validators                           */
/* -------------------------------------------------------------------------- */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function fallbackIsUUID(v) {
    return typeof v === "string" && UUID_RE.test(v);
}
const validateUUID = (v) => (typeof validators_1.isUUID === "function" ? (0, validators_1.isUUID)(v) : fallbackIsUUID(v));
function safeSaveIdempotency(req, res, status, body) {
    // Persist idempotency response, but do not let persistence failure block main response
    // saveIdempotencyResponse might be undefined in some setups — guard it.
    if (typeof idempotency_1.saveIdempotencyResponse !== "function")
        return Promise.resolve();
    return (0, idempotency_1.saveIdempotencyResponse)(req, res, status, body).catch((e) => {
        // log but do not throw
        try {
            logger_1.default?.warn?.("idempotency.save_failed", { err: e, tenant: req.session?.tenantId, key: req.headers?.["idempotency-key"] });
        }
        catch { }
    });
}
/* -------------------------------------------------------------------------- */
/*                                   Zod Schemas                               */
/* -------------------------------------------------------------------------- */
const createSchema = zod_1.z.object({
    patient_id: zod_1.z.string().refine(validateUUID, { message: "invalid patient_id" }),
    clinician_id: zod_1.z.string().refine(validateUUID, { message: "invalid clinician_id" }),
    starts_at: zod_1.z.string().refine((s) => !Number.isNaN(Date.parse(s)), { message: "invalid starts_at" }),
    ends_at: zod_1.z.string().refine((s) => !Number.isNaN(Date.parse(s)), { message: "invalid ends_at" }),
    notes: zod_1.z.string().optional().nullable(),
    type: zod_1.z.string().optional(),
    mode: zod_1.z.string().optional(),
    priority: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).optional(),
    source: zod_1.z.string().optional()
});
const rescheduleSchema = zod_1.z.object({
    newStartsAt: zod_1.z.string().refine((s) => !Number.isNaN(Date.parse(s)), { message: "invalid newStartsAt" }),
    newEndsAt: zod_1.z.string().refine((s) => !Number.isNaN(Date.parse(s)), { message: "invalid newEndsAt" })
});
/* -------------------------------------------------------------------------- */
/*                                   Router                                    */
/* -------------------------------------------------------------------------- */
const router = (0, express_1.Router)();
/* --------------------------------- Create --------------------------------- */
/**
 * POST /
 * Body: { patient_id, clinician_id, starts_at, ends_at, ... }
 * Optional header: Idempotency-Key
 */
router.post("/", requireSession_1.default, idempotency_1.default, (0, asyncHandler_1.default)(async (req, res) => {
    const session = req.session;
    if (!session || !session.tenantId) {
        return res.status(401).json({ error: "unauthenticated" });
    }
    // Validate body
    const parsed = createSchema.safeParse(req.body || {});
    if (!parsed.success) {
        const errBody = { error: "validation_error", details: parsed.error.format() };
        await safeSaveIdempotency(req, res, 422, errBody);
        return res.status(422).json(errBody);
    }
    const body = parsed.data;
    // Normalize dates to ISO UTC and validate ordering
    const starts = new Date(body.starts_at);
    const ends = new Date(body.ends_at);
    if (starts.getTime() >= ends.getTime()) {
        const errBody = { error: "validation_error", message: "starts_at must be before ends_at" };
        await safeSaveIdempotency(req, res, 422, errBody);
        return res.status(422).json(errBody);
    }
    const payload = {
        tenantId: session.tenantId,
        companyId: session.companyId ?? null,
        patient_id: body.patient_id,
        clinician_id: body.clinician_id,
        starts_at: new Date(starts).toISOString(),
        ends_at: new Date(ends).toISOString(),
        notes: body.notes ?? null,
        createdBy: session.userId,
        type: body.type,
        mode: body.mode,
        // coerce priority to string (or undefined) to satisfy CreatePayload
        priority: body.priority === undefined || body.priority === null
            ? undefined
            : String(body.priority),
        source: body.source ?? "api"
    };
    const result = await svc.createAppointment(payload);
    // Service-driven conflict / structured errors
    if (result.error) {
        const code = result.error === "conflict" ? 409 : 400;
        // persist idempotency response if idempotency key exists
        await safeSaveIdempotency(req, res, code, result);
        return res.status(code).json(result);
    }
    const appt = result.appointment ?? result;
    const location = `/hms/appointments/${appt.id}`;
    // Persist idempotency response (best-effort)
    await safeSaveIdempotency(req, res, 201, { appointment: appt });
    res.status(201).location(location).json({ appointment: appt });
}));
/* ------------------------------ Reschedule ------------------------------ */
/**
 * PUT /:id/reschedule
 * Body: { newStartsAt, newEndsAt }
 * Optional header: Idempotency-Key
 */
router.put("/:id/reschedule", requireSession_1.default, idempotency_1.default, (0, asyncHandler_1.default)(async (req, res) => {
    const session = req.session;
    const appointmentId = req.params.id;
    if (!validateUUID(appointmentId)) {
        const err = { error: "validation_error", message: "invalid appointment id" };
        await safeSaveIdempotency(req, res, 400, err);
        return res.status(400).json(err);
    }
    const parsed = rescheduleSchema.safeParse(req.body || {});
    if (!parsed.success) {
        const errBody = { error: "validation_error", details: parsed.error.format() };
        await safeSaveIdempotency(req, res, 422, errBody);
        return res.status(422).json(errBody);
    }
    const { newStartsAt, newEndsAt } = parsed.data;
    const starts = new Date(newStartsAt);
    const ends = new Date(newEndsAt);
    if (starts.getTime() >= ends.getTime()) {
        const errBody = { error: "validation_error", message: "newStartsAt must be before newEndsAt" };
        await safeSaveIdempotency(req, res, 422, errBody);
        return res.status(422).json(errBody);
    }
    const r = await svc.rescheduleAppointment({
        tenantId: session.tenantId,
        appointmentId,
        newStartsAt: starts.toISOString(),
        newEndsAt: ends.toISOString(),
        userId: session.userId
    });
    if (r.error) {
        const mapping = { conflict: 409, not_found: 404, forbidden: 403 };
        const status = mapping[r.error] ?? 400;
        await safeSaveIdempotency(req, res, status, r);
        return res.status(status).json(r);
    }
    await safeSaveIdempotency(req, res, 200, { appointment: r.appointment ?? r });
    return res.json({ appointment: r.appointment ?? r });
}));
/* -------------------------------- Cancel --------------------------------- */
/**
 * POST /:id/cancel
 * Body: { reason }
 * Optional header: Idempotency-Key
 */
router.post("/:id/cancel", requireSession_1.default, idempotency_1.default, (0, asyncHandler_1.default)(async (req, res) => {
    const session = req.session;
    const appointmentId = req.params.id;
    if (!validateUUID(appointmentId)) {
        const err = { error: "validation_error", message: "invalid appointment id" };
        await safeSaveIdempotency(req, res, 400, err);
        return res.status(400).json(err);
    }
    const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;
    const r = await svc.cancelAppointment({ tenantId: session.tenantId, appointmentId, userId: session.userId, reason });
    if (r.error) {
        const status = r.error === "not_found" ? 404 : 400;
        await safeSaveIdempotency(req, res, status, r);
        return res.status(status).json(r);
    }
    await safeSaveIdempotency(req, res, 200, { appointment: r.appointment ?? r });
    return res.json({ appointment: r.appointment ?? r });
}));
/* ------------------------------- Get by Id ------------------------------- */
/**
 * GET /:id
 * Returns appointment detail (tenant-scoped)
 */
router.get("/:id", requireSession_1.default, (0, asyncHandler_1.default)(async (req, res) => {
    const session = req.session;
    const appointmentId = req.params.id;
    if (!validateUUID(appointmentId)) {
        return res.status(400).json({ error: "validation_error", message: "invalid appointment id" });
    }
    const appt = await svc.getAppointmentById({ tenantId: session.tenantId, appointmentId });
    if (!appt)
        return res.status(404).json({ error: "not_found" });
    // return consistent shape
    return res.json({ appointment: appt });
}));
/* ---------------------------------- List --------------------------------- */
/**
 * GET /
 * Query: clinician_id, patient_id, from, to, limit, page/cursor (optional)
 *
 * Returns: { data: [...], meta: { count, limit, returned } }
 */
router.get("/", requireSession_1.default, (0, asyncHandler_1.default)(async (req, res) => {
    const session = req.session;
    const q = req.query || {};
    // parse + validation for common filters
    const clinician_id = typeof q.clinician_id === "string" && validateUUID(q.clinician_id) ? q.clinician_id : undefined;
    const patient_id = typeof q.patient_id === "string" && validateUUID(q.patient_id) ? q.patient_id : undefined;
    const from = typeof q.from === "string" && !Number.isNaN(Date.parse(q.from)) ? new Date(q.from).toISOString() : undefined;
    const to = typeof q.to === "string" && !Number.isNaN(Date.parse(q.to)) ? new Date(q.to).toISOString() : undefined;
    const requestedLimit = typeof q.limit === "string" ? parseInt(q.limit, 10) || 0 : 0;
    const DEFAULT_LIMIT = 100;
    const HARD_LIMIT = 1000;
    const limit = Math.min(HARD_LIMIT, requestedLimit > 0 ? requestedLimit : DEFAULT_LIMIT);
    const rows = await svc.listAppointments({
        tenantId: session.tenantId,
        clinician_id,
        patient_id,
        from,
        to,
        limit
    });
    const meta = { returned: Array.isArray(rows) ? rows.length : 0, limit };
    return res.json({ data: rows, meta });
}));
exports.default = router;
