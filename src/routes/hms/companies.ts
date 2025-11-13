import { Router } from "express";
import requireSession from "../../middleware/requireSession";
import { pool } from "../../db";

const router = Router();

/**
 * GET /hms/companies
 * Returns all companies the current user has access to,
 * fully validated by tenant and membership.
 * Uses actual schema from your DB (company + user_companies).
 */
router.get("/", requireSession, async (req, res) => {
  const r = req as any;
  const session = r.session;
  const tenantId = session?.tenant_id;
  const userId = session?.user_id;

  if (!tenantId || !userId) {
    return res.status(401).json({ error: "unauthenticated" });
  }

  const cx = await pool.connect();
  try {
    const q = await cx.query(
      `
      SELECT
        c.id,
        c.name,
        c.enabled,
        uc.is_default,
        c.created_at
      FROM public.company c
      JOIN public.user_companies uc
        ON uc.company_id = c.id
       AND uc.tenant_id = c.tenant_id
      WHERE uc.tenant_id = $1
        AND uc.user_id = $2
      ORDER BY uc.is_default DESC, c.name ASC
      `,
      [tenantId, userId]
    );

    const companies = q.rows.map((row) => ({
      id: row.id,
      name: row.name,
      enabled: !!row.enabled,
      is_default: !!row.is_default,
      created_at: row.created_at,
    }));

    res.json({ ok: true, data: companies });
  } catch (err: any) {
    console.error("[GET /hms/companies] error:", err);
    res.status(500).json({ error: "internal_server_error" });
  } finally {
    cx.release();
  }
});

export default router;
