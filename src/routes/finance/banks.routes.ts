import { Router } from "express";
import { pool } from "../../db";

const router = Router();

router.get("/", async (req: any, res) => {
  const { tenant_id, company_id } = req.session;
  const r = await pool.query(
    `SELECT * FROM accounting_bank_accounts WHERE tenant_id=$1 AND company_id=$2`,
    [tenant_id, company_id]
  );
  res.json({ banks: r.rows });
});

router.post("/", async (req: any, res) => {
  const { name, account_no } = req.body;
  const { tenant_id, company_id } = req.session;

  const r = await pool.query(
    `INSERT INTO accounting_bank_accounts
     (id, tenant_id, company_id, name, account_no)
     VALUES (gen_random_uuid(),$1,$2,$3,$4)
     RETURNING *`,
    [tenant_id, company_id, name, account_no]
  );

  res.json(r.rows[0]);
});

export default router;
