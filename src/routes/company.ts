import { Router } from "express";
import { pool } from "../db";
import requireSession from "../middleware/requireSession";

const router = Router();

/**
 * POST /api/company/switch
 * Body: { company_id: string }
 * Validates and updates user's active company in session + cookie.
 */
router.post("/set-default", requireSession, async (req, res) => {
  const { company_id } = req.body ?? {};
  const r = req as any;
  const s = r.session;

  if (!company_id) {
    return res.status(400).json({ error: "missing_company_id" });
  }

  const cx = await pool.connect();
  try {
    // verify membership
    const memberCheck = await cx.query(
      `select 1 from public.user_companies
        where tenant_id = $1 and user_id = $2 and company_id = $3`,
      [s.tenant_id, s.user_id, company_id]
    );

    if (memberCheck.rowCount === 0)
      return res.status(403).json({ error: "access_denied_to_company" });

    // clear old defaults, set new one in a single transaction
    await cx.query("BEGIN");
    await cx.query(
      `update public.user_companies
          set is_default = false
        where tenant_id = $1 and user_id = $2`,
      [s.tenant_id, s.user_id]
    );
    await cx.query(
      `update public.user_companies
          set is_default = true
        where tenant_id = $1 and user_id = $2 and company_id = $3`,
      [s.tenant_id, s.user_id, company_id]
    );
    await cx.query("COMMIT");

    return res.json({ ok: true, company_id });
  } catch (err: any) {
    await cx.query("ROLLBACK");
    console.error("[POST /api/company/set-default] error:", err);
    return res.status(500).json({ error: "internal_server_error" });
  } finally {
    cx.release();
  }
});


export default router;
