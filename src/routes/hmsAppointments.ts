// server/src/routes/hmsAppointments.ts
import { Router, Request, Response } from "express";
import { z } from "zod";
import requireSession from "../middleware/requireSession";
import idempotency, { saveIdempotencyResponse } from "../middleware/idempotency";
import * as svc from "../services/appointmentsService";
import asyncHandler from "../utils/asyncHandler"; // small wrapper: (fn) => (req,res,next) => fn(req,res,next).catch(next)
import { isUUID } from "../utils/validators"; // optional helper, fallback included below
import logger from "../lib/logger"; // optional - replace with console if you don't have a logger

/* -------------------------------------------------------------------------- */
/*                              Types & Interfaces                             */
/* -------------------------------------------------------------------------- */

interface SessionInfo {
  tenantId: string;
  companyId?: string | null;
  userId: string;
  roles?: string[];
}

type TypedRequest<P = any, B = any, Q = any> = Request<P, any, B, Q> & { session?: SessionInfo; idempotencyKey?: string };

/* -------------------------------------------------------------------------- */
/*                              Helpers / Validators                           */
/* -------------------------------------------------------------------------- */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function fallbackIsUUID(v: unknown) {
  return typeof v === "string" && UUID_RE.test(v);
}
const validateUUID = (v: unknown) => (typeof isUUID === "function" ? isUUID(v as string) : fallbackIsUUID(v));

function safeSaveIdempotency(req: Request, res: Response, status: number, body: any) {
  // Persist idempotency response, but do not let persistence failure block main response
  // saveIdempotencyResponse might be undefined in some setups — guard it.
  if (typeof saveIdempotencyResponse !== "function") return Promise.resolve();
  return saveIdempotencyResponse(req as any, res as any, status, body).catch((e: any) => {
    // log but do not throw
    try {
      logger?.warn?.("idempotency.save_failed", { err: e, tenant: (req as any).session?.tenantId, key: (req as any).headers?.["idempotency-key"] });
    } catch {}
  });
}

/* -------------------------------------------------------------------------- */
/*                                   Zod Schemas                               */
/* -------------------------------------------------------------------------- */

const createSchema = z.object({
  patient_id: z.string().refine(validateUUID, { message: "invalid patient_id" }),
  clinician_id: z.string().refine(validateUUID, { message: "invalid clinician_id" }),
  starts_at: z.string().refine((s) => !Number.isNaN(Date.parse(s)), { message: "invalid starts_at" }),
  ends_at: z.string().refine((s) => !Number.isNaN(Date.parse(s)), { message: "invalid ends_at" }),
  notes: z.string().optional().nullable(),
  type: z.string().optional(),
  mode: z.string().optional(),
  priority: z.union([z.string(), z.number()]).optional(),
  source: z.string().optional()
});

const rescheduleSchema = z.object({
  newStartsAt: z.string().refine((s) => !Number.isNaN(Date.parse(s)), { message: "invalid newStartsAt" }),
  newEndsAt: z.string().refine((s) => !Number.isNaN(Date.parse(s)), { message: "invalid newEndsAt" })
});

/* -------------------------------------------------------------------------- */
/*                                   Router                                    */
/* -------------------------------------------------------------------------- */

const router = Router();

/* --------------------------------- Create --------------------------------- */
/**
 * POST /
 * Body: { patient_id, clinician_id, starts_at, ends_at, ... }
 * Optional header: Idempotency-Key
 */
router.post(
  "/",
  requireSession,
  idempotency,
  asyncHandler(async (req: TypedRequest<{}, any>, res: Response) => {
    const session = req.session!;
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
    if ((result as any).error) {
      const code = (result as any).error === "conflict" ? 409 : 400;
      // persist idempotency response if idempotency key exists
      await safeSaveIdempotency(req, res, code, result);
      return res.status(code).json(result);
    }

    const appt = (result as any).appointment ?? result;
    const location = `/hms/appointments/${appt.id}`;

    // Persist idempotency response (best-effort)
    await safeSaveIdempotency(req, res, 201, { appointment: appt });

    res.status(201).location(location).json({ appointment: appt });
  })
);

/* ------------------------------ Reschedule ------------------------------ */
/**
 * PUT /:id/reschedule
 * Body: { newStartsAt, newEndsAt }
 * Optional header: Idempotency-Key
 */
router.put(
  "/:id/reschedule",
  requireSession,
  idempotency,
  asyncHandler(async (req: TypedRequest<{ id: string }, any>, res: Response) => {
    const session = req.session!;
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

    if ((r as any).error) {
      const mapping: Record<string, number> = { conflict: 409, not_found: 404, forbidden: 403 };
      const status = mapping[(r as any).error] ?? 400;
      await safeSaveIdempotency(req, res, status, r);
      return res.status(status).json(r);
    }

    await safeSaveIdempotency(req, res, 200, { appointment: r.appointment ?? r });
    return res.json({ appointment: r.appointment ?? r });
  })
);

/* -------------------------------- Cancel --------------------------------- */
/**
 * POST /:id/cancel
 * Body: { reason }
 * Optional header: Idempotency-Key
 */
router.post(
  "/:id/cancel",
  requireSession,
  idempotency,
  asyncHandler(async (req: TypedRequest<{ id: string }, any>, res: Response) => {
    const session = req.session!;
    const appointmentId = req.params.id;
    if (!validateUUID(appointmentId)) {
      const err = { error: "validation_error", message: "invalid appointment id" };
      await safeSaveIdempotency(req, res, 400, err);
      return res.status(400).json(err);
    }

    const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;

    const r = await svc.cancelAppointment({ tenantId: session.tenantId, appointmentId, userId: session.userId, reason });

    if ((r as any).error) {
      const status = (r as any).error === "not_found" ? 404 : 400;
      await safeSaveIdempotency(req, res, status, r);
      return res.status(status).json(r);
    }

    await safeSaveIdempotency(req, res, 200, { appointment: r.appointment ?? r });
    return res.json({ appointment: r.appointment ?? r });
  })
);

/* ------------------------------- Get by Id ------------------------------- */
/**
 * GET /:id
 * Returns appointment detail (tenant-scoped)
 */
router.get(
  "/:id",
  requireSession,
  asyncHandler(async (req: TypedRequest<{ id: string }>, res: Response) => {
    const session = req.session!;
    const appointmentId = req.params.id;
    if (!validateUUID(appointmentId)) {
      return res.status(400).json({ error: "validation_error", message: "invalid appointment id" });
    }

    const appt = await svc.getAppointmentById({ tenantId: session.tenantId, appointmentId });
    if (!appt) return res.status(404).json({ error: "not_found" });

    // return consistent shape
    return res.json({ appointment: appt });
  })
);

/* ---------------------------------- List --------------------------------- */
/**
 * GET /
 * Query: clinician_id, patient_id, from, to, limit, page/cursor (optional)
 *
 * Returns: { data: [...], meta: { count, limit, returned } }
 */
router.get(
  "/",
  requireSession,
  asyncHandler(async (req: TypedRequest<{}, any, any>, res: Response) => {
    const session = req.session!;
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
  })
);

export default router;
