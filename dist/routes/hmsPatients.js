"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// server/src/routes/hmsPatients.ts
const express_1 = require("express");
const db_1 = require("../db");
const requireSession_1 = __importDefault(require("../middleware/requireSession"));
const uuid_1 = require("uuid");
const uuid_2 = require("uuid");
const ids_1 = require("../lib/ids");
const ai_1 = require("../lib/ai");
const router = (0, express_1.Router)();
/**
 * Helper: extract tenant_id from session (enforce multi-tenant)
 */
function getTenantId(req) {
    // requireSession will ensure req.session exists (but double-check)
    // session shape inferred from your auth.ts
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = req.session;
    return s?.tenant_id || s?.company_id || null;
}
/**
 * Helper: normalize name payloads
 * - If payload.name exists and first_name is missing, split name into first_name / last_name.
 * - Mutates the body object for convenience.
 */
function normalizeNameFields(body) {
    if (!body || typeof body !== "object")
        return;
    if (body.name && !body.first_name) {
        const raw = String(body.name).trim();
        if (raw.length === 0) {
            body.first_name = "";
            body.last_name = null;
            return;
        }
        const parts = raw.split(/\s+/);
        body.first_name = parts.shift() || "";
        body.last_name = parts.length > 0 ? parts.join(" ") : null;
    }
}
/**
 * GET /hms/patients
 * Query params:
 *  - q: text query (fuzzy on name/patient_number)
 *  - status
 *  - limit, offset
 */
router.get("/", requireSession_1.default, async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        if (!tenantId)
            return res.status(403).json({ error: "missing_tenant" });
        const qText = String(req.query.q || "").trim();
        const status = req.query.status ? String(req.query.status) : null;
        const limit = Math.min(Number(req.query.limit) || 50, 500);
        const offset = Number(req.query.offset) || 0;
        // Basic search: if q provided use trigram/tsv indexes; otherwise simple tenant listing
        if (qText) {
            const qResult = await (0, db_1.q)(`SELECT id, tenant_id, company_id, patient_number, first_name, last_name, dob, gender, contact, metadata, status, created_at, updated_at
           FROM public.hms_patient
          WHERE tenant_id = $1
            AND (to_tsvector('simple', COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) @@ plainto_tsquery('simple', $2)
                 OR patient_number ILIKE '%' || $2 || '%'
                 OR (contact::text ILIKE '%' || $2 || '%'))
          ORDER BY created_at DESC
          LIMIT $3 OFFSET $4`, [tenantId, qText, limit, offset]);
            return res.json({ rows: qResult.rows, total: qResult.rowCount });
        }
        // default list
        const params = [tenantId, limit, offset];
        let whereExtra = "";
        if (status) {
            whereExtra = ` AND status = $4`;
            params.splice(2, 0, status); // ensure params order matches $4 being status
        }
        const listQ = whereExtra.length > 0
            ? `SELECT id, tenant_id, company_id, patient_number, first_name, last_name, dob, gender, contact, metadata, status, created_at, updated_at
            FROM public.hms_patient
           WHERE tenant_id = $1 ${whereExtra}
           ORDER BY created_at DESC
           LIMIT $3 OFFSET $4`
            : `SELECT id, tenant_id, company_id, patient_number, first_name, last_name, dob, gender, contact, metadata, status, created_at, updated_at
            FROM public.hms_patient
           WHERE tenant_id = $1
           ORDER BY created_at DESC
           LIMIT $2 OFFSET $3`;
        const rows = (await (0, db_1.q)(listQ, params)).rows;
        return res.json({ rows, total: rows.length });
    }
    catch (err) {
        console.error("GET /hms/patients error:", err);
        return res.status(500).json({ error: "list_failed" });
    }
});
/**
 * POST /hms/patients
 * Create a new patient
 */
router.post("/", requireSession_1.default, async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        if (!tenantId)
            return res.status(403).json({ error: "missing_tenant" });
        const userId = req.session?.user_id || null;
        const body = req.body || {};
        // Normalize 'name' -> first_name/last_name (if provided)
        normalizeNameFields(body);
        const first_name = (body.first_name || "").trim();
        const last_name = (body.last_name || "").trim();
        if (!first_name)
            return res.status(400).json({ error: "first_name_required" });
        // auto-generate patient_number if not provided
        let patient_number = body.patient_number || null;
        if (!patient_number) {
            patient_number = await (0, ids_1.generatePatientNumber)(tenantId);
        }
        // basic JSON fields
        const identifiers = body.identifiers || {};
        const contact = body.contact || {};
        const metadata = body.metadata || {};
        const dob = body.dob ? new Date(body.dob) : null;
        const gender = body.gender || null;
        const external_id = body.external_id || null;
        const company_id = body.company_id || null;
        const id = body.id && (0, uuid_2.validate)(body.id) ? body.id : (0, uuid_1.v4)();
        const insertQ = `
      INSERT INTO public.hms_patient
        (id, tenant_id, company_id, patient_number, first_name, last_name, dob, gender, identifiers, contact, metadata, created_by, updated_by, external_id, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      RETURNING id, patient_number, first_name, last_name, dob, gender, identifiers, contact, metadata, status, created_at, updated_at
    `;
        const params = [
            id,
            tenantId,
            company_id,
            patient_number,
            first_name,
            last_name || null,
            dob,
            gender,
            JSON.stringify(identifiers),
            JSON.stringify(contact),
            JSON.stringify(metadata),
            userId,
            userId,
            external_id,
            body.status || "active",
        ];
        const { rows } = await (0, db_1.q)(insertQ, params);
        const created = rows[0];
        // optional: trigger background AI job via callAi stub (non-blocking)
        if (created) {
            // best effort — don't fail create if AI fails
            (0, ai_1.callAi)("patient.created", { patientId: created.id, tenantId }).catch((e) => console.error("AI hook failed (patient.created):", e));
        }
        return res.status(201).json({ patient: created });
    }
    catch (err) {
        console.error("POST /hms/patients error:", err);
        if (err.code === "23505") {
            // unique violation (e.g., patient_number unique per tenant)
            return res.status(409).json({ error: "patient_conflict" });
        }
        return res.status(500).json({ error: "create_failed" });
    }
});
/**
 * GET /hms/patients/:id
 */
router.get("/:id", requireSession_1.default, async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        if (!tenantId)
            return res.status(403).json({ error: "missing_tenant" });
        const id = req.params.id;
        if (!(0, uuid_2.validate)(id))
            return res.status(400).json({ error: "invalid_id" });
        const { rows } = await (0, db_1.q)(`SELECT id, tenant_id, company_id, patient_number, first_name, last_name, dob, gender, identifiers, contact, metadata, status, created_at, updated_at, external_id, merged_into
         FROM public.hms_patient
        WHERE id = $1 AND tenant_id = $2
        LIMIT 1`, [id, tenantId]);
        const row = rows[0];
        if (!row)
            return res.status(404).json({ error: "not_found" });
        return res.json({ patient: row });
    }
    catch (err) {
        console.error("GET /hms/patients/:id error:", err);
        return res.status(500).json({ error: "fetch_failed" });
    }
});
/**
 * PUT /hms/patients/:id
 * Update patient (full replace semantics)
 */
router.put("/:id", requireSession_1.default, async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        if (!tenantId)
            return res.status(403).json({ error: "missing_tenant" });
        const id = req.params.id;
        if (!(0, uuid_2.validate)(id))
            return res.status(400).json({ error: "invalid_id" });
        // ensure exists & belongs to tenant
        const existing = await (0, db_1.q)(`SELECT id FROM public.hms_patient WHERE id = $1 AND tenant_id = $2 LIMIT 1`, [id, tenantId]);
        if (!existing.rows[0])
            return res.status(404).json({ error: "not_found" });
        const body = req.body || {};
        // Normalize 'name' -> first_name/last_name
        normalizeNameFields(body);
        const first_name = (body.first_name || "").trim();
        if (!first_name)
            return res.status(400).json({ error: "first_name_required" });
        const last_name = body.last_name || null;
        const dob = body.dob ? new Date(body.dob) : null;
        const gender = body.gender || null;
        const identifiers = body.identifiers || {};
        const contact = body.contact || {};
        const metadata = body.metadata || {};
        const external_id = body.external_id || null;
        const updated_by = req.session?.user_id || null;
        const status = body.status || "active";
        const updateQ = `
      UPDATE public.hms_patient
         SET first_name = $1,
             last_name = $2,
             dob = $3,
             gender = $4,
             identifiers = $5,
             contact = $6,
             metadata = $7,
             external_id = $8,
             updated_by = $9,
             status = $10,
             updated_at = now()
       WHERE id = $11 AND tenant_id = $12
       RETURNING id, patient_number, first_name, last_name, dob, gender, identifiers, contact, metadata, status, created_at, updated_at, external_id
    `;
        const params = [
            first_name,
            last_name,
            dob,
            gender,
            JSON.stringify(identifiers),
            JSON.stringify(contact),
            JSON.stringify(metadata),
            external_id,
            updated_by,
            status,
            id,
            tenantId,
        ];
        const { rows } = await (0, db_1.q)(updateQ, params);
        return res.json({ patient: rows[0] });
    }
    catch (err) {
        console.error("PUT /hms/patients/:id error:", err);
        return res.status(500).json({ error: "update_failed" });
    }
});
/**
 * PATCH /hms/patients/:id — partial update (sparse)
 */
router.patch("/:id", requireSession_1.default, async (req, res) => {
    // For brevity: implement partial update by reading existing record, merging and updating
    try {
        const tenantId = getTenantId(req);
        if (!tenantId)
            return res.status(403).json({ error: "missing_tenant" });
        const id = req.params.id;
        if (!(0, uuid_2.validate)(id))
            return res.status(400).json({ error: "invalid_id" });
        const { rows: existingRows } = await (0, db_1.q)(`SELECT * FROM public.hms_patient WHERE id = $1 AND tenant_id = $2 LIMIT 1`, [id, tenantId]);
        const existing = existingRows[0];
        if (!existing)
            return res.status(404).json({ error: "not_found" });
        // Merge JSON columns carefully
        const body = req.body || {};
        // Normalize 'name' -> first_name/last_name in the incoming patch body
        normalizeNameFields(body);
        const updated = {
            first_name: body.first_name ?? existing.first_name,
            last_name: body.last_name ?? existing.last_name,
            dob: body.dob ? new Date(body.dob) : existing.dob,
            gender: body.gender ?? existing.gender,
            identifiers: { ...(existing.identifiers || {}), ...(body.identifiers || {}) },
            contact: { ...(existing.contact || {}), ...(body.contact || {}) },
            metadata: { ...(existing.metadata || {}), ...(body.metadata || {}) },
            external_id: body.external_id ?? existing.external_id,
            status: body.status ?? existing.status,
            updated_by: req.session?.user_id || existing.updated_by,
        };
        const updateQ = `
      UPDATE public.hms_patient
         SET first_name = $1,
             last_name = $2,
             dob = $3,
             gender = $4,
             identifiers = $5,
             contact = $6,
             metadata = $7,
             external_id = $8,
             status = $9,
             updated_by = $10,
             updated_at = now()
       WHERE id = $11 AND tenant_id = $12
       RETURNING id, patient_number, first_name, last_name, dob, gender, identifiers, contact, metadata, status, created_at, updated_at, external_id
    `;
        const params = [
            updated.first_name,
            updated.last_name,
            updated.dob,
            updated.gender,
            JSON.stringify(updated.identifiers),
            JSON.stringify(updated.contact),
            JSON.stringify(updated.metadata),
            updated.external_id,
            updated.status,
            updated.updated_by,
            id,
            tenantId,
        ];
        const { rows } = await (0, db_1.q)(updateQ, params);
        return res.json({ patient: rows[0] });
    }
    catch (err) {
        console.error("PATCH /hms/patients/:id error:", err);
        return res.status(500).json({ error: "patch_failed" });
    }
});
/**
 * DELETE /hms/patients/:id
 * Soft-delete by setting status = 'deleted' and merged_into if provided
 */
router.delete("/:id", requireSession_1.default, async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        if (!tenantId)
            return res.status(403).json({ error: "missing_tenant" });
        const id = req.params.id;
        if (!(0, uuid_2.validate)(id))
            return res.status(400).json({ error: "invalid_id" });
        const mergedInto = req.body?.merged_into ?? null;
        const updated_by = req.session?.user_id || null;
        const { rows } = await (0, db_1.q)(`UPDATE public.hms_patient
          SET status = 'deleted', merged_into = $1, updated_by = $2, updated_at = now()
        WHERE id = $3 AND tenant_id = $4
        RETURNING id`, [mergedInto, updated_by, id, tenantId]);
        if (!rows[0])
            return res.status(404).json({ error: "not_found" });
        // non-blocking AI hook
        (0, ai_1.callAi)("patient.deleted", { patientId: id, tenantId }).catch((e) => console.error("AI hook failed (patient.deleted):", e));
        return res.json({ ok: true });
    }
    catch (err) {
        console.error("DELETE /hms/patients/:id error:", err);
        return res.status(500).json({ error: "delete_failed" });
    }
});
/**
 * AI-ready endpoint: POST /hms/patients/:id/ai/summary
 * Returns a generated clinical summary (stub calling lib/ai)
 */
router.post("/:id/ai/summary", requireSession_1.default, async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        if (!tenantId)
            return res.status(403).json({ error: "missing_tenant" });
        const id = req.params.id;
        if (!(0, uuid_2.validate)(id))
            return res.status(400).json({ error: "invalid_id" });
        // Fetch core patient demographics + recent encounters (limit 10)
        const [{ rows: pr }] = [await (0, db_1.q)(`SELECT id, first_name, last_name, dob, gender, identifiers, contact, metadata FROM public.hms_patient WHERE id = $1 AND tenant_id = $2 LIMIT 1`, [id, tenantId])];
        const patient = pr[0];
        if (!patient)
            return res.status(404).json({ error: "not_found" });
        // Fetch recent encounters (lightweight)
        const enc = await (0, db_1.q)(`SELECT id, encounter_date, summary, metadata
         FROM public.hms_encounter
        WHERE patient_id = $1 AND tenant_id = $2
        ORDER BY encounter_date DESC
        LIMIT 10`, [id, tenantId]);
        // call AI service (synchronous) — may be slow: keep a timeout client-side; this is a convenience endpoint
        const promptPayload = {
            patient,
            recentEncounters: enc.rows,
        };
        const summary = await (0, ai_1.callAi)("generate_patient_summary", promptPayload);
        // Optionally persist summary into metadata.ai_summary (not mandatory)
        await (0, db_1.q)(`UPDATE public.hms_patient SET metadata = metadata || $1::jsonb, updated_at = now() WHERE id = $2 AND tenant_id = $3`, [
            JSON.stringify({ ai_summary: summary }),
            id,
            tenantId,
        ]);
        return res.json({ summary });
    }
    catch (err) {
        console.error("POST /hms/patients/:id/ai/summary error:", err);
        return res.status(500).json({ error: "ai_summary_failed" });
    }
});
exports.default = router;
