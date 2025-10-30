"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAppointmentById = getAppointmentById;
exports.createAppointment = createAppointment;
exports.rescheduleAppointment = rescheduleAppointment;
exports.cancelAppointment = cancelAppointment;
exports.listAppointments = listAppointments;
// server/src/services/appointmentsService.ts
const db_1 = __importDefault(require("../db"));
const { withTx, q } = db_1.default; // adapt to your db module's default export
const appointmentLogs_1 = require("./appointmentLogs");
const outbox_1 = require("./outbox"); // transactional outbox helper
async function getAppointmentById({ tenantId, appointmentId }) {
    const text = `
    SELECT a.*,
      p.first_name AS patient_first, p.last_name AS patient_last, p.phone AS patient_phone, p.email AS patient_email,
      c.first_name AS clinician_first, c.last_name AS clinician_last, c.phone AS clinician_phone, c.email AS clinician_email
    FROM public.hms_appointments a
    LEFT JOIN public.hms_patient p ON p.id = a.patient_id AND p.tenant_id = a.tenant_id
    LEFT JOIN public.hms_clinicians c ON c.id = a.clinician_id AND c.tenant_id = a.tenant_id
    WHERE a.id = $1 AND a.tenant_id = $2 AND a.deleted_at IS NULL
    LIMIT 1
  `;
    const res = await q(text, [appointmentId, tenantId]);
    return res.rows[0] || null;
}
async function createAppointment(payload) {
    // Use transaction to avoid race conditions; use advisory lock per clinician
    return withTx(async (client) => {
        const { tenantId, clinician_id, starts_at, ends_at } = payload;
        // 0) Acquire advisory lock scoped to clinician_id for this TX (serialize per-clinician)
        // hashtext returns an int; pg_advisory_xact_lock accepts bigints/ints.
        await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [clinician_id]);
        // 1) conflict check (clinician) - ensure no overlapping appointments
        const conflictQ = `
      SELECT id FROM public.hms_appointments
      WHERE tenant_id = $1 AND clinician_id = $2
        AND deleted_at IS NULL
        AND NOT (ends_at <= $3 OR starts_at >= $4)
      FOR SHARE
    `;
        const conflictRes = await client.query(conflictQ, [tenantId, clinician_id, starts_at, ends_at]);
        if (conflictRes.rowCount > 0) {
            const conflictIds = conflictRes.rows.map((r) => r.id);
            return { error: 'conflict', conflictIds };
        }
        // 2) insert appointment
        const insertQ = `
      INSERT INTO public.hms_appointments
        (id, tenant_id, company_id, patient_id, clinician_id, department_id, location_id, room_id,
         starts_at, ends_at, status, type, mode, priority, notes, source, created_at, created_by)
      VALUES (gen_random_uuid(), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now(), $15)
      RETURNING *
    `;
        const vals = [
            payload.tenantId,
            payload.companyId || null,
            payload.patient_id,
            payload.clinician_id,
            null, // department_id
            null, // location_id
            null, // room_id
            payload.starts_at,
            payload.ends_at,
            payload.status || 'scheduled',
            payload.type || 'consultation',
            payload.mode || 'in_person',
            payload.priority || 'normal',
            payload.notes || null,
            payload.createdBy
        ];
        const insertRes = await client.query(insertQ, vals);
        const appt = insertRes.rows[0];
        // 3) write appointment log (inside the same tx)
        await (0, appointmentLogs_1.writeAppointmentLog)(client, {
            tenantId: payload.tenantId,
            appointmentId: appt.id,
            event: 'created',
            payload: { createdBy: payload.createdBy, source: payload.source || 'api' },
            createdBy: payload.createdBy
        });
        // 4) write outbox row inside same tx: event_type = 'appointment.created'
        // This makes event durable only when tx commits; worker will pick it up and publish.
        await (0, outbox_1.writeOutbox)(client, {
            tenantId: payload.tenantId,
            aggregateType: 'appointment',
            aggregateId: appt.id,
            eventType: 'appointment.created',
            payload: { appointment: appt }
        });
        // 5) return created appointment (no direct enqueue here)
        return { ok: true, appointment: appt };
    });
}
async function rescheduleAppointment({ tenantId, appointmentId, newStartsAt, newEndsAt, userId }) {
    return withTx(async (client) => {
        // ensure appointment belongs to tenant and exists (lock row)
        const selectQ = `SELECT * FROM public.hms_appointments WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL FOR UPDATE`;
        const s = await client.query(selectQ, [appointmentId, tenantId]);
        if (s.rowCount === 0)
            return { error: 'not_found' };
        const appt = s.rows[0];
        // Acquire advisory lock on clinician (serialize reschedules for the clinician)
        await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [appt.clinician_id]);
        // conflict check excluding this appointment
        const conflictQ = `
      SELECT id FROM public.hms_appointments
      WHERE tenant_id = $1 AND clinician_id = $2 AND id != $3
        AND deleted_at IS NULL
        AND NOT (ends_at <= $4 OR starts_at >= $5)
      FOR SHARE
    `;
        const conflicts = await client.query(conflictQ, [tenantId, appt.clinician_id, appointmentId, newStartsAt, newEndsAt]);
        if (conflicts.rowCount > 0) {
            return { error: 'conflict', conflictIds: conflicts.rows.map((r) => r.id) };
        }
        const updateQ = `UPDATE public.hms_appointments SET starts_at = $1, ends_at = $2, updated_at = now(), updated_by = $3 WHERE id = $4 RETURNING *`;
        const updated = await client.query(updateQ, [newStartsAt, newEndsAt, userId, appointmentId]);
        await (0, appointmentLogs_1.writeAppointmentLog)(client, {
            tenantId,
            appointmentId,
            event: 'rescheduled',
            payload: { old: appt, new: updated.rows[0] },
            createdBy: userId
        });
        // write outbox for reschedule event (inside tx)
        await (0, outbox_1.writeOutbox)(client, {
            tenantId,
            aggregateType: 'appointment',
            aggregateId: appointmentId,
            eventType: 'appointment.rescheduled',
            payload: { old: appt, new: updated.rows[0], changedBy: userId }
        });
        // Return created appointment
        return { ok: true, appointment: updated.rows[0] };
    });
}
async function cancelAppointment({ tenantId, appointmentId, userId, reason }) {
    return withTx(async (client) => {
        const updateQ = `UPDATE public.hms_appointments SET status = 'cancelled', updated_at = now(), updated_by = $1 WHERE id = $2 AND tenant_id = $3 RETURNING *`;
        const res = await client.query(updateQ, [userId, appointmentId, tenantId]);
        if (res.rowCount === 0)
            return { error: 'not_found' };
        const appt = res.rows[0];
        await (0, appointmentLogs_1.writeAppointmentLog)(client, {
            tenantId,
            appointmentId,
            event: 'cancelled',
            payload: { reason },
            createdBy: userId
        });
        // write outbox for cancelled event
        await (0, outbox_1.writeOutbox)(client, {
            tenantId,
            aggregateType: 'appointment',
            aggregateId: appointmentId,
            eventType: 'appointment.cancelled',
            payload: { appointment: appt, cancelledBy: userId, reason }
        });
        return { ok: true, appointment: appt };
    });
}
async function listAppointments({ tenantId, clinician_id, patient_id, from, to, limit = 500 }) {
    const params = [tenantId];
    let where = 'WHERE tenant_id = $1 AND deleted_at IS NULL';
    if (clinician_id) {
        params.push(clinician_id);
        where += ` AND clinician_id = $${params.length}`;
    }
    if (patient_id) {
        params.push(patient_id);
        where += ` AND patient_id = $${params.length}`;
    }
    if (from) {
        params.push(from);
        where += ` AND ends_at >= $${params.length}`;
    }
    if (to) {
        params.push(to);
        where += ` AND starts_at <= $${params.length}`;
    }
    const qtext = `
    SELECT a.*,
      p.first_name AS patient_first, p.last_name AS patient_last,
      c.first_name AS clinician_first, c.last_name AS clinician_last
    FROM public.hms_appointments a
    LEFT JOIN public.hms_patient p ON p.id = a.patient_id AND p.tenant_id = a.tenant_id
    LEFT JOIN public.hms_clinicians c ON c.id = a.clinician_id AND c.tenant_id = a.tenant_id
    ${where}
    ORDER BY starts_at ASC
    LIMIT ${Math.min(2000, Math.max(50, limit))}
  `;
    const r = await q(qtext, params);
    return r.rows;
}
exports.default = {
    createAppointment,
    getAppointmentById,
    rescheduleAppointment,
    cancelAppointment,
    listAppointments
};
