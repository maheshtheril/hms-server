"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAdmission = createAdmission;
exports.getAdmissionById = getAdmissionById;
exports.listAdmissions = listAdmissions;
exports.updateAdmission = updateAdmission;
exports.dischargeAdmission = dischargeAdmission;
exports.deleteAdmission = deleteAdmission;
// server/src/services/admissionsService.ts
const dbCompat_1 = require("../dbCompat");
function ensureObject(v) {
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}
async function createAdmission(payload) {
    const client = await (0, dbCompat_1.getClient)();
    try {
        await client.query("BEGIN");
        const metadata = Object.assign({}, payload.metadata ?? {}, {
            createdBy: payload.createdBy ?? null,
        });
        const sql = `
      INSERT INTO public.hms_admission
        (tenant_id, company_id, patient_id, encounter_id, admitted_at, discharged_at,
         ward, bed, admitting_doctor, status, metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *;
    `;
        const result = await client.query(sql, [
            payload.tenantId,
            payload.companyId,
            payload.patient_id,
            payload.encounter_id ?? null,
            payload.admitted_at ?? new Date().toISOString(),
            null,
            payload.ward ?? null,
            payload.bed ?? null,
            payload.admitting_doctor ?? null,
            payload.status ?? "admitted",
            JSON.stringify(metadata),
        ]);
        await client.query("COMMIT");
        const row = result.rows[0];
        row.metadata = ensureObject(row.metadata);
        return { admission: row };
    }
    catch (err) {
        await client.query("ROLLBACK");
        // handle unique index conflict (bed occupied)
        if (err?.code === "23505" && err?.detail?.includes("hms_admission_bed_unique")) {
            return { error: "conflict", reason: "bed_occupied", detail: err?.detail ?? null };
        }
        console.error("admissionsService.createAdmission", err);
        return { error: "server_error", detail: err?.message };
    }
    finally {
        try {
            client.release();
        }
        catch { }
    }
}
async function getAdmissionById({ tenantId, admissionId, }) {
    const sql = `
    SELECT a.*, p.full_name AS patient_name, e.started_at AS encounter_started_at
    FROM public.hms_admission a
    LEFT JOIN public.hms_patient p ON p.id = a.patient_id
    LEFT JOIN public.hms_encounter e ON e.id = a.encounter_id
    WHERE a.id = $1 AND a.tenant_id = $2
    LIMIT 1;
  `;
    const r = await (0, dbCompat_1.q)(sql, [admissionId, tenantId]);
    if (!r.rowCount)
        return null;
    const ad = r.rows[0];
    ad.metadata = ensureObject(ad.metadata);
    return ad;
}
async function listAdmissions(opts) {
    const params = [];
    let where = ` WHERE a.tenant_id = $1 `;
    params.push(opts.tenantId);
    if (opts.patient_id) {
        params.push(opts.patient_id);
        where += ` AND a.patient_id = $${params.length} `;
    }
    if (opts.encounter_id) {
        params.push(opts.encounter_id);
        where += ` AND a.encounter_id = $${params.length} `;
    }
    if (opts.ward) {
        params.push(opts.ward);
        where += ` AND a.ward = $${params.length} `;
    }
    if (opts.status) {
        params.push(opts.status);
        where += ` AND a.status = $${params.length} `;
    }
    if (opts.from) {
        params.push(opts.from);
        where += ` AND a.admitted_at >= $${params.length} `;
    }
    if (opts.to) {
        params.push(opts.to);
        where += ` AND a.admitted_at <= $${params.length} `;
    }
    const limit = opts.limit ?? 500;
    params.push(limit);
    const sql = `
    SELECT a.*, p.full_name AS patient_name, e.started_at AS encounter_started_at
    FROM public.hms_admission a
    LEFT JOIN public.hms_patient p ON p.id = a.patient_id
    LEFT JOIN public.hms_encounter e ON e.id = a.encounter_id
    ${where}
    ORDER BY a.admitted_at DESC
    LIMIT $${params.length};
  `;
    const r = await (0, dbCompat_1.q)(sql, params);
    return r.rows.map((row) => {
        row.metadata = ensureObject(row.metadata);
        return row;
    });
}
async function updateAdmission(payload) {
    const client = await (0, dbCompat_1.getClient)();
    try {
        await client.query("BEGIN");
        const fetch = await client.query(`SELECT * FROM public.hms_admission WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [payload.admissionId, payload.tenantId]);
        if (!fetch.rowCount) {
            await client.query("ROLLBACK");
            return { error: "not_found" };
        }
        const existing = fetch.rows[0];
        const metadata = Object.assign({}, ensureObject(existing.metadata), payload.metadata ?? {});
        const upd = await client.query(`
      UPDATE public.hms_admission
         SET ward = $1,
             bed = $2,
             admitting_doctor = $3,
             status = $4,
             discharged_at = $5,
             metadata = $6
       WHERE id = $7
       RETURNING *;
    `, [
            payload.ward ?? existing.ward,
            payload.bed ?? existing.bed,
            payload.admitting_doctor ?? existing.admitting_doctor,
            payload.status ?? existing.status,
            payload.discharged_at ?? existing.discharged_at,
            JSON.stringify(metadata),
            payload.admissionId,
        ]);
        await client.query("COMMIT");
        const updated = upd.rows[0];
        updated.metadata = ensureObject(updated.metadata);
        return { admission: updated };
    }
    catch (err) {
        await client.query("ROLLBACK");
        console.error("admissionsService.updateAdmission", err);
        return { error: "server_error", detail: err?.message };
    }
    finally {
        try {
            client.release();
        }
        catch { }
    }
}
async function dischargeAdmission({ tenantId, admissionId, discharged_at, dischargedBy, notes, }) {
    const client = await (0, dbCompat_1.getClient)();
    try {
        await client.query("BEGIN");
        const f = await client.query(`SELECT * FROM public.hms_admission WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [admissionId, tenantId]);
        if (!f.rowCount) {
            await client.query("ROLLBACK");
            return { error: "not_found" };
        }
        const existing = f.rows[0];
        if (existing.status === "discharged") {
            await client.query("ROLLBACK");
            return { error: "already_discharged", admission: existing };
        }
        const metadata = ensureObject(existing.metadata);
        const endedAt = discharged_at ?? new Date().toISOString();
        metadata.status = "discharged";
        metadata.dischargedBy = dischargedBy ?? null;
        if (notes)
            metadata.discharge_notes = notes;
        metadata.discharged_at = endedAt;
        const upd = await client.query(`UPDATE public.hms_admission SET discharged_at=$1,status=$2,metadata=$3 WHERE id=$4 RETURNING *`, [endedAt, "discharged", JSON.stringify(metadata), admissionId]);
        await client.query("COMMIT");
        const row = upd.rows[0];
        row.metadata = ensureObject(row.metadata);
        return { admission: row };
    }
    catch (err) {
        await client.query("ROLLBACK");
        console.error("admissionsService.dischargeAdmission", err);
        return { error: "server_error", detail: err?.message };
    }
    finally {
        try {
            client.release();
        }
        catch { }
    }
}
async function deleteAdmission({ tenantId, admissionId, }) {
    const client = await (0, dbCompat_1.getClient)();
    try {
        await client.query("BEGIN");
        const f = await client.query(`SELECT id FROM public.hms_admission WHERE id=$1 AND tenant_id=$2 LIMIT 1`, [admissionId, tenantId]);
        if (!f.rowCount) {
            await client.query("ROLLBACK");
            return { error: "not_found" };
        }
        await client.query(`DELETE FROM public.hms_admission WHERE id=$1`, [admissionId]);
        await client.query("COMMIT");
        return { success: true };
    }
    catch (err) {
        await client.query("ROLLBACK");
        console.error("admissionsService.deleteAdmission", err);
        return { error: "server_error", detail: err?.message };
    }
    finally {
        try {
            client.release();
        }
        catch { }
    }
}
