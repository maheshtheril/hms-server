// server/src/routes/hmsEncounters.ts
import { Router } from "express";
import requireSession from "../middleware/requireSession";
import idempotency, { saveIdempotencyResponse } from "../middleware/idempotency";
import * as svc from "../services/encountersService";
import { q } from "../db";

const router = Router();

// POST / - create
router.post("/", requireSession, idempotency, async (req: any, res) => {
  try {
    const s = req.session;
    const b = req.body || {};
    if (!b.patient_id || !b.clinician_id) return res.status(400).json({ error: "patient_id and clinician_id required" });

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
    if ((result as any).error) {
      const status = (result as any).error === "conflict" ? 409 : 500;
      await saveIdempotencyResponse(req, res, status, result);
      return res.status(status).json(result);
    }
    await saveIdempotencyResponse(req, res, 201, { encounter: result.encounter });
    return res.status(201).json({ encounter: result.encounter });
  } catch (err) {
    console.error("encounters.create", err);
    return res.status(500).json({ error: "server_error" });
  }
});

// GET /:id
router.get("/:id", requireSession, async (req: any, res) => {
  try {
    const s = req.session;
    const id = req.params.id;
    const enc = await svc.getEncounterById({ tenantId: s.tenantId, encounterId: id });
    if (!enc) return res.status(404).json({ error: "not_found" });
    return res.json(enc);
  } catch (err) {
    console.error("encounters.get", err);
    return res.status(500).json({ error: "server_error" });
  }
});

// GET / (list)
router.get("/", requireSession, async (req: any, res) => {
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
  } catch (err) {
    console.error("encounters.list", err);
    return res.status(500).json({ error: "server_error" });
  }
});

// PUT /:id - update metadata and simple fields
router.put("/:id", requireSession, async (req: any, res) => {
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
    if ((r as any).error === "not_found") return res.status(404).json(r);
    if ((r as any).error) return res.status(500).json(r);
    return res.json({ encounter: r.encounter });
  } catch (err) {
    console.error("encounters.update", err);
    return res.status(500).json({ error: "server_error" });
  }
});

// PUT /:id/close - close encounter (idempotent middleware handles responses)
router.put("/:id/close", requireSession, idempotency, async (req: any, res) => {
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
    if ((r as any).error === "not_found") { await saveIdempotencyResponse(req, res, 404, r); return res.status(404).json(r); }
    if ((r as any).error) { await saveIdempotencyResponse(req, res, 409, r); return res.status(409).json(r); }
    await saveIdempotencyResponse(req, res, 200, { encounter: r.encounter });
    return res.json({ encounter: r.encounter });
  } catch (err) {
    console.error("encounters.close", err);
    return res.status(500).json({ error: "server_error" });
  }
});

// DELETE /:id
router.delete("/:id", requireSession, async (req: any, res) => {
  try {
    const s = req.session;
    const id = req.params.id;
    const r = await svc.deleteEncounter({ tenantId: s.tenantId, encounterId: id });
    if ((r as any).error === "not_found") return res.status(404).json(r);
    if ((r as any).error) return res.status(500).json(r);
    return res.json({ success: true });
  } catch (err) {
    console.error("encounters.delete", err);
    return res.status(500).json({ error: "server_error" });
  }
});

export default router;
