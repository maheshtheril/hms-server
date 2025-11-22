// server/src/lib/provisioningQueue.ts
import type { PoolClient } from "pg";
import { pool } from "../db";

export type ProvisionJobPayload = {
  tenantId: string;
  companyId: string;
  userId: string;
  countryId?: string | null;
  // any extra flags you want
  [k: string]: any;
};

export async function enqueueProvisionJob(payload: ProvisionJobPayload, scheduledAt?: Date | null) {
  const client = await pool.connect();
  try {
    const sql = `
      INSERT INTO provisioning_jobs
        (tenant_id, company_id, user_id, payload, status, scheduled_at, created_at, updated_at)
      VALUES ($1,$2,$3,$4,'queued',$5,now(),now())
      RETURNING id, created_at
    `;
    const res = await client.query(sql, [
      payload.tenantId,
      payload.companyId,
      payload.userId,
      payload as any,
      scheduledAt ? scheduledAt.toISOString() : null,
    ]);
    return { ok: true, id: res.rows[0].id, createdAt: res.rows[0].created_at };
  } catch (err) {
    console.error("[provisionQueue] enqueue error:", err);
    return { ok: false, error: (err as any).message ?? String(err) };
  } finally {
    client.release();
  }
}

/**
 * For workers: atomically claim the next queued job.
 * Marks it in_progress and returns the job row for processing.
 *
 * Usage pattern:
 *  - call dequeueProvisionJobForWorker(workerName)
 *  - if returns null -> sleep & retry
 *  - process job
 *  - on success -> markJobDone(id)
 *  - on failure -> markJobFailed(id, err, attempts++)
 */
export async function dequeueProvisionJobForWorker(workerName = "worker") {
  const cx = await pool.connect();
  try {
    await cx.query("BEGIN");
    // pick an available job: queued, scheduled_at <= now OR scheduled_at IS NULL
    const sel = await cx.query(
      `
      SELECT id, tenant_id, company_id, user_id, payload, attempts
      FROM provisioning_jobs
      WHERE status = 'queued' AND (scheduled_at IS NULL OR scheduled_at <= now())
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
      `
    );
    if (sel.rowCount === 0) {
      await cx.query("COMMIT");
      return null;
    }
    const job = sel.rows[0];
    await cx.query(
      `UPDATE provisioning_jobs
         SET status = 'in_progress', started_at = now(), updated_at = now(), attempts = attempts + 1
       WHERE id = $1`,
      [job.id]
    );
    await cx.query("COMMIT");
    return {
      id: job.id,
      tenantId: job.tenant_id,
      companyId: job.company_id,
      userId: job.user_id,
      payload: job.payload as ProvisionJobPayload,
      attempts: job.attempts,
    };
  } catch (err) {
    try { await cx.query("ROLLBACK"); } catch(e){/* ignore */ }
    console.error("[provisionQueue] dequeue error:", err);
    return null;
  } finally {
    cx.release();
  }
}

export async function markJobDone(id: string) {
  const cx = await pool.connect();
  try {
    await cx.query(
      `UPDATE provisioning_jobs SET status = 'done', finished_at = now(), updated_at = now() WHERE id = $1`,
      [id]
    );
    return { ok: true };
  } catch (err) {
    console.error("[provisionQueue] markJobDone error:", err);
    return { ok: false, error: (err as any).message ?? String(err) };
  } finally {
    cx.release();
  }
}

export async function markJobFailed(id: string, lastError: string, retryDelaySeconds?: number) {
  const cx = await pool.connect();
  try {
    const nextScheduled = retryDelaySeconds ? `now() + interval '${retryDelaySeconds} seconds'` : null;
    const sql = nextScheduled
      ? `UPDATE provisioning_jobs SET status='queued', last_error=$2, updated_at=now(), scheduled_at=${nextScheduled} WHERE id=$1`
      : `UPDATE provisioning_jobs SET status='failed', last_error=$2, updated_at=now() WHERE id=$1`;
    if (nextScheduled) {
      await cx.query(sql, [id, lastError]);
    } else {
      await cx.query(sql, [id, lastError]);
    }
    return { ok: true };
  } catch (err) {
    console.error("[provisionQueue] markJobFailed error:", err);
    return { ok: false, error: (err as any).message ?? String(err) };
  } finally {
    cx.release();
  }
}
