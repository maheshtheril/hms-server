import db from "../db";

export async function detectDuplicate(tenant_id: string, email?: string|null, phone?: string|null) {
  const rows = (await db.query(
    `SELECT id FROM public.lead
     WHERE tenant_id=$1 AND (primary_email=$2 OR primary_phone=$3)`,
    [tenant_id, email ?? null, phone ?? null]
  )).rows;
  return rows[0]?.id ?? null;
}
