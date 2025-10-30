// server/workers/appointmentWorker.ts
import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { q } from '../src/db';
//import { callAIForSummary } from '../src/ai/calls'; // optional ai helper

const connection = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

const worker = new Worker('appointments', async (job) => {
  const { tenantId, appointmentId } = job.data;
  if (!tenantId || !appointmentId) return;

  // 1) fetch appointment + patient/clinician contact
  const apptRes = await q(`
    SELECT a.*, p.phone AS patient_phone, p.email AS patient_email, c.phone AS clinician_phone, c.email AS clinician_email
    FROM public.hms_appointments a
    LEFT JOIN public.hms_patient p ON p.id = a.patient_id AND p.tenant_id = a.tenant_id
    LEFT JOIN public.hms_clinicians c ON c.id = a.clinician_id AND c.tenant_id = a.tenant_id
    WHERE a.id = $1 AND a.tenant_id = $2
  `, [appointmentId, tenantId]);

  if (apptRes.rowCount === 0) {
    console.warn('worker: appointment not found', appointmentId);
    return;
  }
  const appt = apptRes.rows[0];

  // 2) Send reminders / notifications (example placeholder: call Notification service)
  try {
    // Example: push to your SMS/email microservice (HTTP call or another queue)
    // await notify.sendSms(appt.patient_phone, `Reminder: your appointment is at ${new Date(appt.starts_at).toLocaleString()}`);
    // await notify.sendEmail(appt.patient_email, 'Appointment booked', ...)

    // 3) AI: Pre-generate recommended checklist / risk if desired (lightweight)
    // Not heavy: you can call embeddings or quick Assist calls here (or push to another AI queue)
    // const aiResult = await callAIForSummary({ patientId: appt.patient_id, texts: '...' });

    // 4) Log worker action to appointment_logs
    await q(`INSERT INTO public.hms_appointment_logs (id, tenant_id, appointment_id, event, payload, created_at) VALUES (gen_random_uuid(), $1,$2,$3,$4, now())`,
      [tenantId, appointmentId, 'worker_processed', JSON.stringify({ notified: true })]);

  } catch (e) {
    console.error('appointmentWorker error', e);
    throw e; // allow BullMQ to handle retries per job options
  }
}, { connection });

worker.on('failed', (job, err) => {
  console.error('Job failed', job?.id, err);
});
worker.on('completed', (job) => {
  console.log('Job completed', job.id);
});
