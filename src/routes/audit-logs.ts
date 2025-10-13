// server/src/routes/audit-logs.ts
import { Router } from "express";
import { pool } from "../db";

const router = Router();

/** (Optional) If you use RLS via app.tenant_id */
async function setTenant(clientOrPool: any, tenantId?: string | null) {
  await clientOrPool.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId ?? null]);
}
/** Read tenant from session or header */
function getTenantId(req: any): string | null {
  return req?.session?.tenant_id ?? (req.headers["x-tenant-id"] as string) ?? null;
}

router.get("/", async (req, res, next) => {
  const page = Math.max(parseInt(String(req.query.page || "1")), 1);
  const pageSize = Math.min(Math.max(parseInt(String(req.query.pageSize || "20")), 1), 100);
  const offset = (page - 1) * pageSize;

  const search = String(req.query.search || "").trim();
  const action = String(req.query.action || "").trim();         // maps to operation
  const dateFrom = String(req.query.date_from || "").trim();
  const dateTo = String(req.query.date_to || "").trim();

  try {
    const tenantId = getTenantId(req);
    await setTenant(pool, tenantId); // harmless if you don’t use it

    const params: any[] = [];
    let where = "WHERE 1=1";

    // Scope to tenant if provided
    if (tenantId) {
      params.push(tenantId);
      where += ` AND tenant_id = $${params.length}`;
    }

    // Search across table_name, operation and diff::text
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      const p = `$${params.length}`;
      where += ` AND (
        LOWER(table_name) LIKE ${p}
        OR LOWER(operation) LIKE ${p}
        OR LOWER(COALESCE(diff::text, '')) LIKE ${p}
      )`;
    }

    // Filter by action (operation)
    if (action) {
      params.push(action);
      where += ` AND operation = $${params.length}`;
    }

    // Date range on created_at
    if (dateFrom) {
      params.push(dateFrom);
      where += ` AND created_at >= $${params.length}::timestamptz`;
    }
    if (dateTo) {
      params.push(dateTo);
      where += ` AND created_at < ($${params.length}::date + INTERVAL '1 day')`;
    }

    // Count
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int AS total FROM public.audit_log ${where}`,
      params
    );
    const total = countRows[0]?.total ?? 0;

    // Page
    params.push(pageSize, offset);

    // Select, aliasing operation → action for the frontend
    const { rows: items } = await pool.query(
      `SELECT
         id,
         created_at,
         operation AS action,
         table_name,
         record_id,
         actor_id,
         diff
       FROM public.audit_log
       ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({ items, page, pageSize, total });
  } catch (e: any) {
    // If table doesn’t exist yet, keep UI alive
    if (e?.code === "42P01") return res.json({ items: [], page, pageSize, total: 0 });
    next(e);
  }
});

// quick canary
router.get("/__health", (_req, res) => res.json({ ok: true, where: "audit-logs router" }));

export default router;
