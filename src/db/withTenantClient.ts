// server/src/db/withTenantClient.ts
import { Pool, PoolClient } from "pg";
import pool from "../pool"; // adjust import to your existing pool export

export type TenantContext = {
  tenant_id: string;
  company_id: string;
  user_id?: string | null;
};

export async function withTenantClient<T>(
  ctx: TenantContext,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // SET LOCAL ensures the GUC only lives for the transaction (safe for pooled clients)
    await client.query("SET LOCAL app.tenant_id = $1", [ctx.tenant_id]);
    await client.query("SET LOCAL app.company_id = $1", [ctx.company_id]);
    if (ctx.user_id) {
      await client.query("SET LOCAL app.user_id = $1", [ctx.user_id]);
    } else {
      await client.query("RESET app.user_id");
    }

    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
