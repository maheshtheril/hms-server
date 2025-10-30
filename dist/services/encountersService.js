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
Object.defineProperty(exports, "__esModule", { value: true });
exports.createEncounter = createEncounter;
exports.getEncounterById = getEncounterById;
exports.listEncounters = listEncounters;
exports.updateEncounter = updateEncounter;
exports.closeEncounter = closeEncounter;
exports.deleteEncounter = deleteEncounter;
// server/src/services/encountersService.ts
const db_1 = __importStar(require("../db"));
function ensureObject(v) {
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}
async function createEncounter(payload) {
    const client = await db_1.default.pool.connect();
    try {
        await client.query("BEGIN");
        const metadata = {
            reason: payload.reason ?? null,
            notes: payload.notes ?? null,
            appointment_id: payload.appointment_id ?? null,
            source: payload.source ?? "api",
            createdBy: payload.createdBy ?? null,
            status: "active",
        };
        // Optional: uniqueness guard for appointment_id
        if (payload.appointment_id) {
            const chk = await client.query(`SELECT id FROM public.hms_encounter WHERE tenant_id = $1 AND (metadata->>'appointment_id') = $2 LIMIT 1`, [payload.tenantId, payload.appointment_id]);
            if (chk.rowCount) {
                await client.query("ROLLBACK");
                return { error: "conflict", reason: "appointment_already_has_encounter" };
            }
        }
        const insertSql = `
      INSERT INTO public.hms_encounter
        (tenant_id, company_id, patient_id, encounter_type, started_at, ended_at, clinician_id, metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *;
    `;
        const encounterType = payload.encounter_type ?? "visit";
        const result = await client.query(insertSql, [
            payload.tenantId,
            payload.companyId,
            payload.patient_id,
            encounterType,
            payload.started_at ?? new Date().toISOString(),
            payload.ended_at ?? null,
            payload.clinician_id ?? null,
            JSON.stringify(metadata),
        ]);
        const row = result.rows[0];
        await client.query("COMMIT");
        row.metadata = ensureObject(row.metadata);
        return { encounter: row };
    }
    catch (err) {
        await client.query("ROLLBACK");
        console.error("encountersService.createEncounter", err);
        return { error: "server_error", detail: err?.message };
    }
    finally {
        try {
            client.release();
        }
        catch { }
    }
}
async function getEncounterById({ tenantId, encounterId }) {
    const sql = `
    SELECT e.*, p.full_name AS patient_name, c.full_name AS clinician_name
    FROM public.hms_encounter e
    LEFT JOIN public.hms_patient p ON p.id = e.patient_id
    LEFT JOIN public.hms_clinician c ON c.id = e.clinician_id
    WHERE e.id = $1 AND e.tenant_id = $2
    LIMIT 1;
  `;
    const r = await (0, db_1.q)(sql, [encounterId, tenantId]);
    if (!r.rowCount)
        return null;
    const enc = r.rows[0];
    enc.metadata = ensureObject(enc.metadata);
    return enc;
}
async function listEncounters(opts) {
    const params = [];
    let where = ` WHERE e.tenant_id = $1 `;
    params.push(opts.tenantId);
    if (opts.patient_id) {
        params.push(opts.patient_id);
        where += ` AND e.patient_id = $${params.length} `;
    }
    if (opts.clinician_id) {
        params.push(opts.clinician_id);
        where += ` AND e.clinician_id = $${params.length} `;
    }
    if (opts.from) {
        params.push(opts.from);
        where += ` AND e.started_at >= $${params.length} `;
    }
    if (opts.to) {
        params.push(opts.to);
        where += ` AND e.started_at <= $${params.length} `;
    }
    if (opts.status) {
        params.push(opts.status);
        where += ` AND (e.metadata->>'status') = $${params.length} `;
    }
    const limit = opts.limit ?? 500;
    params.push(limit);
    const sql = `
    SELECT e.*, p.full_name AS patient_name, c.full_name AS clinician_name
    FROM public.hms_encounter e
    LEFT JOIN public.hms_patient p ON p.id = e.patient_id
    LEFT JOIN public.hms_clinician c ON c.id = e.clinician_id
    ${where}
    ORDER BY e.started_at DESC
    LIMIT $${params.length};
  `;
    const r = await (0, db_1.q)(sql, params);
    return r.rows.map((row) => { row.metadata = ensureObject(row.metadata); return row; });
}
async function updateEncounter(payload) {
    const client = await db_1.default.pool.connect();
    try {
        await client.query("BEGIN");
        const fetch = await client.query(`SELECT * FROM public.hms_encounter WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [
            payload.encounterId,
            payload.tenantId,
        ]);
        if (!fetch.rowCount) {
            await client.query("ROLLBACK");
            return { error: "not_found" };
        }
        const existing = fetch.rows[0];
        const metadata = ensureObject(existing.metadata);
        if (payload.reason !== undefined)
            metadata.reason = payload.reason;
        if (payload.notes !== undefined)
            metadata.notes = payload.notes;
        if (payload.appointment_id !== undefined)
            metadata.appointment_id = payload.appointment_id;
        const newStartedAt = payload.started_at !== undefined ? payload.started_at : existing.started_at;
        const newEndedAt = payload.ended_at !== undefined ? payload.ended_at : existing.ended_at;
        const newClinicianId = payload.clinician_id !== undefined ? payload.clinician_id : existing.clinician_id;
        const updateSql = `
      UPDATE public.hms_encounter
         SET started_at = $1,
             ended_at = $2,
             clinician_id = $3,
             metadata = $4
       WHERE id = $5
       RETURNING *;
    `;
        const upd = await client.query(updateSql, [newStartedAt, newEndedAt, newClinicianId, JSON.stringify(metadata), payload.encounterId]);
        await client.query("COMMIT");
        const updated = upd.rows[0];
        updated.metadata = ensureObject(updated.metadata);
        return { encounter: updated };
    }
    catch (err) {
        await client.query("ROLLBACK");
        console.error("encountersService.updateEncounter", err);
        return { error: "server_error", detail: err?.message };
    }
    finally {
        try {
            client.release();
        }
        catch { }
    }
}
async function closeEncounter(payload) {
    const client = await db_1.default.pool.connect();
    try {
        await client.query("BEGIN");
        const fetch = await client.query(`SELECT * FROM public.hms_encounter WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [
            payload.encounterId,
            payload.tenantId,
        ]);
        if (!fetch.rowCount) {
            await client.query("ROLLBACK");
            return { error: "not_found" };
        }
        const existing = fetch.rows[0];
        const metadata = ensureObject(existing.metadata);
        const existingStatus = metadata.status ?? (existing.ended_at ? "closed" : "active");
        if (existingStatus === "closed") {
            await client.query("ROLLBACK");
            return { error: "already_closed", encounter: existing };
        }
        const endedAt = payload.ended_at ?? new Date().toISOString();
        metadata.status = "closed";
        if (payload.outcome !== undefined && payload.outcome !== null)
            metadata.outcome = payload.outcome;
        if (payload.notes !== undefined && payload.notes !== null)
            metadata.close_notes = payload.notes;
        if (payload.closedBy)
            metadata.closedBy = payload.closedBy;
        metadata.closed_at = endedAt;
        const updateSql = `UPDATE public.hms_encounter SET ended_at = $1, metadata = $2 WHERE id = $3 RETURNING *;`;
        const upd = await client.query(updateSql, [endedAt, JSON.stringify(metadata), payload.encounterId]);
        await client.query("COMMIT");
        const updated = upd.rows[0];
        updated.metadata = ensureObject(updated.metadata);
        return { encounter: updated };
    }
    catch (err) {
        await client.query("ROLLBACK");
        console.error("encountersService.closeEncounter", err);
        return { error: "server_error", detail: err?.message };
    }
    finally {
        try {
            client.release();
        }
        catch { }
    }
}
async function deleteEncounter({ tenantId, encounterId }) {
    const client = await db_1.default.pool.connect();
    try {
        await client.query("BEGIN");
        const chk = await client.query(`SELECT id FROM public.hms_encounter WHERE id = $1 AND tenant_id = $2 LIMIT 1`, [encounterId, tenantId]);
        if (!chk.rowCount) {
            await client.query("ROLLBACK");
            return { error: "not_found" };
        }
        await client.query(`DELETE FROM public.hms_encounter WHERE id = $1`, [encounterId]);
        await client.query("COMMIT");
        return { success: true };
    }
    catch (err) {
        await client.query("ROLLBACK");
        console.error("encountersService.deleteEncounter", err);
        return { error: "server_error", detail: err?.message };
    }
    finally {
        try {
            client.release();
        }
        catch { }
    }
}
