// server/workers/outboxWorker.ts
import IORedis from 'ioredis';
import { Queue, Worker, Job } from 'bullmq';
import dbDefault from '../src/db';
const dbAny: any = dbDefault as any;
const { q } = dbAny; // non-transactional helper from your db default export

// Notification + AI helpers
import { sendEmail, sendSms } from '../src/services/notifications';
import { generatePreVisitSummary } from '../src/services/ai';

// Outbox helper SQL snippets (we duplicate minimal logic here instead of importing to avoid cycles)
const CLAIM_SQL = `
WITH candidates AS (
  SELECT id FROM public.hms_outbox
  WHERE processed_at IS NULL
    AND (locked_at IS NULL OR locked_at < now() - interval '5 minutes')
  ORDER BY created_at
  LIMIT $1
  FOR UPDATE SKIP LOCKED
)
UPDATE public.hms_outbox o
SET locked_at = now(), attempts = attempts + 1
FROM candidates c
WHERE o.id = c.id
RETURNING o.id, o.tenant_id, o.aggregate_type, o.aggregate_id, o.event_type, o.payload, o.attempts, o.locked_at, o.created_at;
`;

const MARK_PROCESSED_SQL = `UPDATE public.hms_outbox SET processed_at = now(), last_error = NULL WHERE id = $1`;
const MARK_FAILED_SQL = `UPDATE public.hms_outbox SET last_error = $1 WHERE id = $2`;

/* ---------------------------- Configuration ---------------------------- */
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const BATCH_SIZE = parseInt(process.env.OUTBOX_BATCH_SIZE || '10', 10);
const POLL_INTERVAL_MS = parseInt(process.env.OUTBOX_POLL_MS || '500', 10);
const OUTBOX_QUEUE_NAME = process.env.OUTBOX_QUEUE_NAME || 'outbox-publisher';

/* ---------------------------- Redis / Bull ----------------------------- */
const connection = new IORedis(REDIS_URL);
const outboxQueue = new Queue(OUTBOX_QUEUE_NAME, { connection });

/* ---------------------------- Helpers --------------------------------- */

/**
 * Safely get a short error message from an unknown error value.
 * This avoids TypeScript `err?.message` problems because catch parameters are `unknown`.
 */
function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    // Try to JSON stringify objects (may throw)
    return typeof err === 'string' ? err : JSON.stringify(err);
  } catch (_) {
    return String(err);
  }
}

async function claimBatch(limit = BATCH_SIZE) {
  // Use a client connection to run the claim + update atomically
  const poolClient = await (dbAny.pool ? dbAny.pool.connect() : null);
  if (!poolClient) {
    throw new Error('DB pool client unavailable (dbDefault.pool missing)');
  }

  try {
    await poolClient.query('BEGIN');
    const r = await poolClient.query(CLAIM_SQL, [limit]);
    await poolClient.query('COMMIT');
    return r.rows;
  } catch (err) {
    try { await poolClient.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    try { poolClient.release(); } catch (_) { /* ignore */ }
  }
}

async function markProcessed(id: string) {
  await q(MARK_PROCESSED_SQL, [id]);
}

async function markFailed(id: string, errMsg: string) {
  await q(MARK_FAILED_SQL, [errMsg.substring(0, 2000), id]); // cap error length
}

/* ---------------------------- Job Handlers ----------------------------- */
/**
 * Implement your notification + AI logic here. Keep handlers idempotent.
 * Each handler receives job.data: { outboxId, tenantId, aggregateType, aggregateId, payload }
 */
async function handleAppointmentCreated(job: Job) {
  const { outboxId, tenantId, aggregateId: appointmentId, payload } = job.data as any;

  // 1) fetch appointment details & patient/clinician contact info
  const apptRes = await q(
    `SELECT a.*, 
            p.first_name AS patient_first, p.last_name AS patient_last, p.phone AS patient_phone, p.email AS patient_email,
            c.first_name AS clinician_first, c.last_name AS clinician_last, c.phone AS clinician_phone, c.email AS clinician_email
     FROM public.hms_appointments a
     LEFT JOIN public.hms_patient p ON p.id = a.patient_id AND p.tenant_id = a.tenant_id
     LEFT JOIN public.hms_clinicians c ON c.id = a.clinician_id AND c.tenant_id = a.tenant_id
     WHERE a.id = $1 AND a.tenant_id = $2 LIMIT 1`,
    [appointmentId, tenantId]
  );

  if (apptRes.rowCount === 0) {
    throw new Error('appointment_not_found');
  }
  const appt = apptRes.rows[0];

  // 2) generate short AI pre-visit summary (best-effort; short timeout in ai helper)
  let aiResp: any = { error: 'not_configured' };
  try {
    aiResp = await generatePreVisitSummary({
      patientName: `${appt.patient_first || ''} ${appt.patient_last || ''}`.trim() || undefined,
      clinicianName: `${appt.clinician_first || ''} ${appt.clinician_last || ''}`.trim() || undefined,
      reason: appt.type || undefined,
      notes: appt.notes || undefined
    });
  } catch (e: unknown) {
    console.warn('AI summary failed', getErrorMessage(e));
  }

  // 3) Notify patient by SMS (if phone available)
  if (appt.patient_phone) {
    try {
      const smsMsg = `Your appointment with ${appt.clinician_first || ''} at ${new Date(appt.starts_at).toLocaleString()}.`;
      const smsResult = await sendSms(appt.patient_phone, smsMsg);
      if (!smsResult?.success) {
        console.warn('SMS send failed', smsResult);
      }
    } catch (e: unknown) {
      console.error('sms error', getErrorMessage(e));
    }
  }

  // 4) Notify patient by Email (if email available)
  if (appt.patient_email) {
    try {
      const subject = `Appointment confirmed — ${new Date(appt.starts_at).toLocaleString()}`;
      const bodyHtml = `<p>Hi ${appt.patient_first || ''},</p>
        <p>Your appointment with ${appt.clinician_first || ''} is scheduled at <strong>${new Date(appt.starts_at).toLocaleString()}</strong>.</p>
        ${aiResp?.summary ? `<p><strong>Pre-visit checklist:</strong><br/>${aiResp.summary}</p>` : ''}
        <p>Thank you.</p>`;
      const emailResult = await sendEmail(appt.patient_email, subject, bodyHtml);
      if (!emailResult?.success) {
        console.warn('email send failed', emailResult);
      }
    } catch (e: unknown) {
      console.error('email error', getErrorMessage(e));
    }
  }

  // 5) Notify clinician (optional)
  if (appt.clinician_email) {
    try {
      const subject = `New appointment: ${appt.patient_first || ''} ${appt.patient_last || ''} — ${new Date(appt.starts_at).toLocaleString()}`;
      const bodyHtml = `<p>New appointment booked.</p>
        <p><strong>Patient:</strong> ${appt.patient_first || ''} ${appt.patient_last || ''}</p>
        <p><strong>Time:</strong> ${new Date(appt.starts_at).toLocaleString()}</p>
        ${aiResp?.summary ? `<p><strong>AI Pre-visit:</strong><br/>${aiResp.summary}</p>` : ''}
      `;
      await sendEmail(appt.clinician_email, subject, bodyHtml);
    } catch (e: unknown) {
      console.error('clinician email error', getErrorMessage(e));
    }
  }

  // 6) Log worker action to appointment_logs
  try {
    await q(
      `INSERT INTO public.hms_appointment_logs (id, tenant_id, appointment_id, event, payload, created_at, created_by)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, now(), NULL)`,
      [tenantId, appointmentId, 'worker_notified', JSON.stringify({ notified: true, ai: aiResp })]
    );
  } catch (e: unknown) {
    console.error('Failed to write appointment_logs entry', getErrorMessage(e));
  }

  return true;
}

async function handleAppointmentRescheduled(job: Job) {
  const { outboxId, tenantId, aggregateId: appointmentId, payload } = job.data as any;

  const apptRes = await q(
    `SELECT a.*, 
            p.first_name AS patient_first, p.last_name AS patient_last, p.phone AS patient_phone, p.email AS patient_email,
            c.first_name AS clinician_first, c.last_name AS clinician_last, c.phone AS clinician_phone, c.email AS clinician_email
     FROM public.hms_appointments a
     LEFT JOIN public.hms_patient p ON p.id = a.patient_id AND p.tenant_id = a.tenant_id
     LEFT JOIN public.hms_clinicians c ON c.id = a.clinician_id AND c.tenant_id = a.tenant_id
     WHERE a.id = $1 AND a.tenant_id = $2 LIMIT 1`,
    [appointmentId, tenantId]
  );

  if (apptRes.rowCount === 0) throw new Error('appointment_not_found');
  const appt = apptRes.rows[0];

  // Notify patient & clinician (best-effort)
  try {
    if (appt.patient_phone) {
      await sendSms(appt.patient_phone, `Your appointment time has changed to ${new Date(appt.starts_at).toLocaleString()}.`);
    }
  } catch (e: unknown) { console.error('reschedule sms error', getErrorMessage(e)); }

  try {
    if (appt.patient_email) {
      await sendEmail(
        appt.patient_email,
        `Appointment rescheduled — ${new Date(appt.starts_at).toLocaleString()}`,
        `<p>Your appointment has been rescheduled to <strong>${new Date(appt.starts_at).toLocaleString()}</strong>.</p>`
      );
    }
  } catch (e: unknown) { console.error('reschedule email error', getErrorMessage(e)); }

  try {
    await q(
      `INSERT INTO public.hms_appointment_logs (id, tenant_id, appointment_id, event, payload, created_at)
       VALUES (gen_random_uuid(), $1,$2,$3,$4, now())`,
      [tenantId, appointmentId, 'worker_rescheduled_notified', JSON.stringify({ payload })]
    );
  } catch (e: unknown) {
    console.error('Failed to write reschedule appointment_logs', getErrorMessage(e));
  }

  return true;
}

async function handleAppointmentCancelled(job: Job) {
  const { outboxId, tenantId, aggregateId: appointmentId, payload } = job.data as any;

  const apptRes = await q(
    `SELECT a.*,
            p.first_name AS patient_first, p.last_name AS patient_last, p.phone AS patient_phone, p.email AS patient_email,
            c.first_name AS clinician_first, c.last_name AS clinician_last, c.phone AS clinician_phone, c.email AS clinician_email
     FROM public.hms_appointments a
     LEFT JOIN public.hms_patient p ON p.id = a.patient_id AND p.tenant_id = a.tenant_id
     LEFT JOIN public.hms_clinicians c ON c.id = a.clinician_id AND c.tenant_id = a.tenant_id
     WHERE a.id = $1 AND a.tenant_id = $2 LIMIT 1`,
    [appointmentId, tenantId]
  );

  if (apptRes.rowCount === 0) throw new Error('appointment_not_found');
  const appt = apptRes.rows[0];

  // Notify patient/clinician & log
  try {
    if (appt.patient_phone) {
      await sendSms(appt.patient_phone, `Your appointment scheduled at ${new Date(appt.starts_at).toLocaleString()} has been cancelled.`);
    }
  } catch (e: unknown) { console.error('cancel sms error', getErrorMessage(e)); }

  try {
    if (appt.patient_email) {
      await sendEmail(
        appt.patient_email,
        `Appointment cancelled — ${new Date(appt.starts_at).toLocaleString()}`,
        `<p>Your appointment on <strong>${new Date(appt.starts_at).toLocaleString()}</strong> has been cancelled.</p>`
      );
    }
  } catch (e: unknown) { console.error('cancel email error', getErrorMessage(e)); }

  try {
    await q(
      `INSERT INTO public.hms_appointment_logs (id, tenant_id, appointment_id, event, payload, created_at)
       VALUES (gen_random_uuid(), $1,$2,$3,$4, now())`,
      [tenantId, appointmentId, 'worker_cancelled_notified', JSON.stringify({ payload })]
    );
  } catch (e: unknown) {
    console.error('Failed to write cancel appointment_logs', getErrorMessage(e));
  }

  return true;
}

/* ---------------------------- Setup worker ------------------------------ */
/**
 * We use BullMQ Worker consumer to process jobs that were enqueued by this same worker
 * after claiming rows. This two-step (claim -> addJob -> worker) gives you flexibility:
 * - You can publish the job to different queues
 * - You can have multiple consumers/handlers per event type
 *
 * Another simpler model is to publish directly (HTTP) in the claim loop; here we use BullMQ for retries/backoff.
 */

const publisherWorker = new Worker(OUTBOX_QUEUE_NAME, async (job: Job) => {
  // job.data expected shape: { outboxId, tenantId, aggregateType, aggregateId, payload }
  const event = job.name; // name is the event_type we added when queue.add was called
  try {
    if (event === 'appointment.created') {
      await handleAppointmentCreated(job);
    } else if (event === 'appointment.rescheduled') {
      await handleAppointmentRescheduled(job);
    } else if (event === 'appointment.cancelled') {
      await handleAppointmentCancelled(job);
    } else {
      // generic fallback
      console.warn('No handler for event', event);
    }

    // mark the outbox row processed (job succeeded)
    const outboxId = (job.data as any).outboxId;
    if (outboxId) await markProcessed(outboxId);
  } catch (err: unknown) {
    // record failure (keep job failing so BullMQ can retry too)
    const outboxId = (job.data as any).outboxId;
    if (outboxId) await markFailed(outboxId, getErrorMessage(err));
    console.error('Worker handler error for job', job.id, getErrorMessage(err));
    throw err; // rethrow so BullMQ handles retry/backoff
  }
}, { connection });

publisherWorker.on('completed', (job) => {
  console.log('Job completed', job.id, job.name);
});
publisherWorker.on('failed', (job, err) => {
  console.error('Job failed', job?.id, getErrorMessage(err));
});

/* --------------------------- Main polling loop -------------------------- */
async function pollLoop() {
  while (true) {
    try {
      const rows = await claimBatch(BATCH_SIZE);
      if (!rows || rows.length === 0) {
        // nothing to do — sleep
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        continue;
      }

      // Enqueue each claimed outbox row into BullMQ for handling
      for (const row of rows) {
        try {
          await outboxQueue.add(row.event_type || 'generic.event', {
            outboxId: row.id,
            tenantId: row.tenant_id,
            aggregateType: row.aggregate_type,
            aggregateId: row.aggregate_id,
            payload: row.payload
          }, { attempts: 5, backoff: { type: 'exponential', delay: 2000 } });
        } catch (err: unknown) {
          console.error('Failed to enqueue outbox job', row.id, getErrorMessage(err));
          // mark failed (so it appears in outbox.last_error). Worker will retry claim later.
          try { await markFailed(row.id, getErrorMessage(err)); } catch (e: unknown) { console.error('markFailed error', getErrorMessage(e)); }
        }
      }
    } catch (err: unknown) {
      console.error('Outbox poll error', getErrorMessage(err));
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

/* ------------------------------ Start ---------------------------------- */
console.log('Starting outbox worker (polling) with Redis:', REDIS_URL);
pollLoop().catch((err: unknown) => {
  console.error('Outbox worker fatal error', getErrorMessage(err));
  process.exit(1);
});

// handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down outbox worker...');
  try { await outboxQueue.close(); } catch (_) { /* ignore */ }
  try { await publisherWorker.close(); } catch (_) { /* ignore */ }
  process.exit(0);
});
