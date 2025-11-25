import { Router } from "express";
import { pool } from "../../db";

const router = Router();

router.get("/", async (req: any, res) => {
  const { tenant_id, company_id } = req.session;
  const r = await pool.query(
    `SELECT * FROM accounting_chart_of_accounts
     WHERE tenant_id=$1 AND company_id=$2
     ORDER BY code ASC`,
    [tenant_id, company_id]
  );
  res.json({ accounts: r.rows });
});

router.post("/", async (req: any, res) => {
  const { code, name, type } = req.body;
  const { tenant_id, company_id, user_id } = req.session;

  const r = await pool.query(
    `INSERT INTO accounting_chart_of_accounts
     (id, tenant_id, company_id, code, name, type, created_by)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6)
     RETURNING *`,
    [tenant_id, company_id, code, name, type, user_id]
  );

  res.json(r.rows[0]);
});

export default router;
