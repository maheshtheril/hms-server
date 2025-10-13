// server/src/routes/admin/companies.ts
import { Router } from "express";
import { pool } from "../../db";
import requireSession from "../../middleware/requireSession";

const router = Router();
router.use(requireSession);

const TENANT_UUID_SQL = `NULLIF(current_setting('app.tenant_id', true), '')::uuid`;

async function setTenantOn(conn: any, req: any) {
  const tid = String(req.session?.tenant_id || req.headers["x-tenant-id"] || "").trim();
  if (!tid) throw Object.assign(new Error("tenant_id_required"), { status: 400 });
  await conn.query(`select set_config('app.tenant_id', $1, false)`, [tid]);
}

router.get("/", async (req: any, res: any, next: any) => {
  const cx = await pool.connect();
  try {
    await setTenantOn(cx, req);
    const { rows } = await cx.query(
      `select id, name from public.company where tenant_id = ${TENANT_UUID_SQL} order by name asc`
    );
    res.json({ items: rows });
  } catch (e: any) {
    if (e?.status === 400) return res.status(400).json({ message: e.message });
    next(e);
  } finally {
    cx.release();
  }
});

export default router;
