// server/src/routes/tenant/companies.ts
import { Router } from "express";
import pool from "../../db"; // adjust if your db export path differs
import requireSession from "../../middleware/requireSession";


const router = Router();

// GET /api/tenant/companies
// Returns companies belonging to the current tenant (from session or X-Tenant header)
router.get("/companies", requireSession, async (req, res) => {
  try {
    const tenantId: string | undefined = (req as any).session?.tenant_id || (req.headers["x-tenant-id"] as string) || null;
    if (!tenantId) return res.status(401).json({ error: "unauthenticated", message: "Missing tenant" });

    // ensure the DB session has app.tenant_id set for RLS/queries
        // ensure the DB session has app.tenant_id set for RLS/queries
    const conn = await pool.pool.connect(); // <- use the real pg.Pool here
    try {
      await conn.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      const q = `select id, name from public.company where tenant_id = current_setting('app.tenant_id', true)::uuid order by name asc`;
      const r = await conn.query(q);
      return res.json(r.rows || []);
    } finally {
      conn.release();
    }

  } catch (err: any) {
    console.error("GET /api/tenant/companies error:", err);
    return res.status(500).json({ error: "server_error", message: String(err?.message || err) });
  }
});

export default router;
