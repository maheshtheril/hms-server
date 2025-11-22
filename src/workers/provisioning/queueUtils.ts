import { pool } from "../../db";

export async function enqueueProvisionJob(job: {
  tenantId: string;
  companyId: string;
  userId: string;
  industry: string | null;
  payload?: any;
}) {
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO provisioning_queue
        (id, tenant_id, company_id, user_id, industry, payload, status, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'pending', now())`,
      [
        job.tenantId,
        job.companyId,
        job.userId,
        job.industry,
        JSON.stringify(job.payload || {}),
      ]
    );
  } finally {
    client.release();
  }
}

export async function getNextProvisioningJob() {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT *
         FROM provisioning_queue
         WHERE status='pending'
         ORDER BY created_at ASC
         LIMIT 1`
    );
    return rows[0] || null;
  } finally {
    client.release();
  }
}

export async function markJobProcessing(id: string) {
  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE provisioning_queue
         SET status='processing', started_at=now()
       WHERE id=$1`,
      [id]
    );
  } finally {
    client.release();
  }
}

export async function markJobDone(id: string) {
  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE provisioning_queue
         SET status='done', finished_at=now()
       WHERE id=$1`,
      [id]
    );
  } finally {
    client.release();
  }
}

export async function markJobFailed(id: string, error: string) {
  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE provisioning_queue
         SET status='failed', finished_at=now(), error=$2
       WHERE id=$1`,
      [id, error]
    );
  } finally {
    client.release();
  }
}
