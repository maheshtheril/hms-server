// server/src/services/appointmentLogs.ts
import { q } from '../db';

export async function writeAppointmentLog(clientOrPool: any, { tenantId, appointmentId, event, payload, createdBy }: { tenantId: string; appointmentId: string; event: string; payload?: any; createdBy?: string }) {
  const text = `INSERT INTO public.hms_appointment_logs (id, tenant_id, appointment_id, event, payload, created_at, created_by)
                VALUES (gen_random_uuid(), $1,$2,$3,$4, now(), $5)`;
  const params = [tenantId, appointmentId, event, payload ? JSON.stringify(payload) : null, createdBy || null];

  // Allow passing a transaction client
  if (clientOrPool.query) {
    await clientOrPool.query(text, params);
  } else {
    await q(text, params);
  }
}
