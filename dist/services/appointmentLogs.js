"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.writeAppointmentLog = writeAppointmentLog;
// server/src/services/appointmentLogs.ts
const db_1 = require("../db");
async function writeAppointmentLog(clientOrPool, { tenantId, appointmentId, event, payload, createdBy }) {
    const text = `INSERT INTO public.hms_appointment_logs (id, tenant_id, appointment_id, event, payload, created_at, created_by)
                VALUES (gen_random_uuid(), $1,$2,$3,$4, now(), $5)`;
    const params = [tenantId, appointmentId, event, payload ? JSON.stringify(payload) : null, createdBy || null];
    // Allow passing a transaction client
    if (clientOrPool.query) {
        await clientOrPool.query(text, params);
    }
    else {
        await (0, db_1.q)(text, params);
    }
}
