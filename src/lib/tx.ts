// server/src/lib/tx.ts
import { pool, type PoolClient } from "../db";

/**
 * Wraps a DB transaction and sets app.tenant for RLS.
 */
export async function withTenant<T>(
  tenantId: string | null,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (tenantId) {
      await client.query("SELECT set_config('app.tenant', $1, true)", [tenantId]);
    }

    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
