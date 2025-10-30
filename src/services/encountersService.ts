// server/src/services/encountersService.ts
import db, { q } from "../db";
import type { PoolClient } from "pg";

/**
 * hms_encounter service
 * - createEncounter
 * - getEncounterById
 * - listEncounters
 * - updateEncounter
 * - closeEncounter
 * - deleteEncounter
 *
 * Uses metadata JSONB for flexible fields (reason, notes, status, appointment_id, outcome, etc).
 */

type CreatePayload = {
  tenantId: string;
  companyId: string | null;
  patient_id: string;
  clinician_id: string;
  appointment_id?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  reason?: string | null;
  notes?: string | null;
  createdBy?: string | null;
  source?: string | null;
  encounter_type?: string | null;
};

type UpdatePayload = {
  tenantId: string;
  encounterId: string;
  reason?: string | null;
  notes?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  appointment_id?: string | null;
  clinician_id?: string | null;
};

type ClosePayload = {
  tenantId: string;
  encounterId: string;
  ended_at?: string | null;
  outcome?: string | null;
  notes?: string | null;
  closedBy?: string | null;
};

function ensureObject(v: any) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

export async function createEncounter(payload: CreatePayload) {
  const client: PoolClient = await db.pool.connect();
  try {
    await client.query("BEGIN");

    const metadata: any = {
      reason: payload.reason ?? null,
      notes: payload.notes ?? null,
      appointment_id: payload.appointment_id ?? null,
      source: payload.source ?? "api",
      createdBy: payload.createdBy ?? null,
      status: "active",
    };

    // Optional: uniqueness guard for appointment_id
    if (payload.appointment_id) {
      const chk = await client.query(
        `SELECT id FROM public.hms_encounter WHERE tenant_id = $1 AND (metadata->>'appointment_id') = $2 LIMIT 1`,
        [payload.tenantId, payload.appointment_id]
      );
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
  } catch (err: any) {
    await client.query("ROLLBACK");
    console.error("encountersService.createEncounter", err);
    return { error: "server_error", detail: err?.message };
  } finally {
    try { client.release(); } catch {}
  }
}

export async function getEncounterById({ tenantId, encounterId }: { tenantId: string; encounterId: string }) {
  const sql = `
    SELECT e.*, p.full_name AS patient_name, c.full_name AS clinician_name
    FROM public.hms_encounter e
    LEFT JOIN public.hms_patient p ON p.id = e.patient_id
    LEFT JOIN public.hms_clinician c ON c.id = e.clinician_id
    WHERE e.id = $1 AND e.tenant_id = $2
    LIMIT 1;
  `;
  const r = await q(sql, [encounterId, tenantId]);
  if (!r.rowCount) return null;
  const enc = r.rows[0];
  enc.metadata = ensureObject(enc.metadata);
  return enc;
}

type ListOpts = {
  tenantId: string;
  patient_id?: string | null;
  clinician_id?: string | null;
  from?: string | null;
  to?: string | null;
  status?: string | null;
  limit?: number;
};

export async function listEncounters(opts: ListOpts) {
  const params: any[] = [];
  let where = ` WHERE e.tenant_id = $1 `;
  params.push(opts.tenantId);

  if (opts.patient_id) { params.push(opts.patient_id); where += ` AND e.patient_id = $${params.length} `; }
  if (opts.clinician_id) { params.push(opts.clinician_id); where += ` AND e.clinician_id = $${params.length} `; }
  if (opts.from) { params.push(opts.from); where += ` AND e.started_at >= $${params.length} `; }
  if (opts.to) { params.push(opts.to); where += ` AND e.started_at <= $${params.length} `; }
  if (opts.status) { params.push(opts.status); where += ` AND (e.metadata->>'status') = $${params.length} `; }

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
  const r = await q(sql, params);
  return r.rows.map((row: any) => { row.metadata = ensureObject(row.metadata); return row; });
}

export async function updateEncounter(payload: UpdatePayload) {
  const client: PoolClient = await db.pool.connect();
  try {
    await client.query("BEGIN");

    const fetch = await client.query(`SELECT * FROM public.hms_encounter WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [
      payload.encounterId,
      payload.tenantId,
    ]);
    if (!fetch.rowCount) { await client.query("ROLLBACK"); return { error: "not_found" }; }

    const existing = fetch.rows[0];
    const metadata = ensureObject(existing.metadata);

    if (payload.reason !== undefined) metadata.reason = payload.reason;
    if (payload.notes !== undefined) metadata.notes = payload.notes;
    if (payload.appointment_id !== undefined) metadata.appointment_id = payload.appointment_id;

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
  } catch (err: any) {
    await client.query("ROLLBACK");
    console.error("encountersService.updateEncounter", err);
    return { error: "server_error", detail: err?.message };
  } finally { try { client.release(); } catch {} }
}

export async function closeEncounter(payload: ClosePayload) {
  const client: PoolClient = await db.pool.connect();
  try {
    await client.query("BEGIN");

    const fetch = await client.query(`SELECT * FROM public.hms_encounter WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [
      payload.encounterId,
      payload.tenantId,
    ]);
    if (!fetch.rowCount) { await client.query("ROLLBACK"); return { error: "not_found" }; }

    const existing = fetch.rows[0];
    const metadata = ensureObject(existing.metadata);
    const existingStatus = (metadata.status as string) ?? (existing.ended_at ? "closed" : "active");
    if (existingStatus === "closed") { await client.query("ROLLBACK"); return { error: "already_closed", encounter: existing }; }

    const endedAt = payload.ended_at ?? new Date().toISOString();
    metadata.status = "closed";
    if (payload.outcome !== undefined && payload.outcome !== null) metadata.outcome = payload.outcome;
    if (payload.notes !== undefined && payload.notes !== null) metadata.close_notes = payload.notes;
    if (payload.closedBy) metadata.closedBy = payload.closedBy;
    metadata.closed_at = endedAt;

    const updateSql = `UPDATE public.hms_encounter SET ended_at = $1, metadata = $2 WHERE id = $3 RETURNING *;`;
    const upd = await client.query(updateSql, [endedAt, JSON.stringify(metadata), payload.encounterId]);
    await client.query("COMMIT");
    const updated = upd.rows[0];
    updated.metadata = ensureObject(updated.metadata);
    return { encounter: updated };
  } catch (err: any) {
    await client.query("ROLLBACK");
    console.error("encountersService.closeEncounter", err);
    return { error: "server_error", detail: err?.message };
  } finally { try { client.release(); } catch {} }
}

export async function deleteEncounter({ tenantId, encounterId }: { tenantId: string; encounterId: string }) {
  const client: PoolClient = await db.pool.connect();
  try {
    await client.query("BEGIN");
    const chk = await client.query(`SELECT id FROM public.hms_encounter WHERE id = $1 AND tenant_id = $2 LIMIT 1`, [encounterId, tenantId]);
    if (!chk.rowCount) { await client.query("ROLLBACK"); return { error: "not_found" }; }
    await client.query(`DELETE FROM public.hms_encounter WHERE id = $1`, [encounterId]);
    await client.query("COMMIT");
    return { success: true };
  } catch (err: any) {
    await client.query("ROLLBACK");
    console.error("encountersService.deleteEncounter", err);
    return { error: "server_error", detail: err?.message };
  } finally { try { client.release(); } catch {} }
}
