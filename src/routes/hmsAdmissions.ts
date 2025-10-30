// server/src/routes/hmsAdmissions.ts
import { Router } from "express";
import requireSession from "../middleware/requireSession";
import idempotency, { saveIdempotencyResponse } from "../middleware/idempotency";
import * as svc from "../services/admissionsService";
import { q } from "../db";

const router = Router();

/* POST / - create admission (idempotent) */
router.post("/", requireSession, idempotency, async (req: any, res) => {
  try {
    const s = req.session;
    const b = req.body || {};
    if (!b.patient_id) return res.status(400).json({ error: "patient_id required" });

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

    if ((r as any).error === "conflict") {
      await saveIdempotencyResponse(req, res, 409, r);
      return res.status(409).json(r);
    }
    if ((r as any).error) {
      await saveIdempotencyResponse(req, res, 500, r);
      return res.status(500).json(r);
    }

    await saveIdempotencyResponse(req, res, 201, { admission: r.admission });
    return res.status(201).json({ admission: r.admission });
  } catch (err) {
    console.error("admissions.create", err);
    return res.status(500).json({ error: "server_error" });
  }
});

/* GET / - list admissions */
router.get("/", requireSession, async (req: any, res) => {
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
  } catch (err) {
    console.error("admissions.list", err);
    return res.status(500).json({ error: "server_error" });
  }
});

/* GET /:id - detail */
router.get("/:id", requireSession, async (req: any, res) => {
  try {
    const s = req.session;
    const r = await svc.getAdmissionById({ tenantId: s.tenantId, admissionId: req.params.id });
    if (!r) return res.status(404).json({ error: "not_found" });
    return res.json(r);
  } catch (err) {
    console.error("admissions.get", err);
    return res.status(500).json({ error: "server_error" });
  }
});

/* PUT /:id - update */
router.put("/:id", requireSession, async (req: any, res) => {
  try {
    const s = req.session;
    const r = await svc.updateAdmission({
      tenantId: s.tenantId,
      admissionId: req.params.id,
      ...req.body,
    });
    if ((r as any).error === "not_found") return res.status(404).json(r);
    if ((r as any).error) return res.status(500).json(r);
    return res.json({ admission: r.admission });
  } catch (err) {
    console.error("admissions.update", err);
    return res.status(500).json({ error: "server_error" });
  }
});

/* PUT /:id/discharge - discharge (idempotent) */
router.put("/:id/discharge", requireSession, idempotency, async (req: any, res) => {
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
    if ((r as any).error === "not_found") {
      await saveIdempotencyResponse(req, res, 404, r);
      return res.status(404).json(r);
    }
    if ((r as any).error) {
      await saveIdempotencyResponse(req, res, 409, r);
      return res.status(409).json(r);
    }
    await saveIdempotencyResponse(req, res, 200, { admission: r.admission });
    return res.json({ admission: r.admission });
  } catch (err) {
    console.error("admissions.discharge", err);
    return res.status(500).json({ error: "server_error" });
  }
});

/* DELETE /:id - delete */
router.delete("/:id", requireSession, async (req: any, res) => {
  try {
    const s = req.session;
    const r = await svc.deleteAdmission({ tenantId: s.tenantId, admissionId: req.params.id });
    if ((r as any).error === "not_found") return res.status(404).json(r);
    if ((r as any).error) return res.status(500).json(r);
    return res.json({ success: true });
  } catch (err) {
    console.error("admissions.delete", err);
    return res.status(500).json({ error: "server_error" });
  }
});

/* GET /beds/available?ward=...&bed=... - check availability */
router.get("/beds/available", requireSession, async (req: any, res) => {
  try {
    const s = req.session;
    const { ward, bed } = req.query;
    if (!ward || !bed) return res.status(400).json({ error: "ward_and_bed_required" });
    const sql = `
      SELECT 1 FROM public.hms_admission
      WHERE tenant_id=$1 AND ward=$2 AND bed=$3
        AND coalesce(status,'admitted')<>'discharged'
      LIMIT 1;
    `;
    const r = await q(sql, [s.tenantId, ward, bed]);
    return res.json({ available: r.rowCount === 0 });
  } catch (err) {
    console.error("admissions.beds.available", err);
    return res.status(500).json({ error: "server_error" });
  }
});

export default router;
