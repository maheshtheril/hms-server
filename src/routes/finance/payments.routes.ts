import { Router } from "express";
import { pool } from "../../db";

const router = Router();

router.post("/receive", async (req: any, res) => {
  const { amount, partner_id, method, reference } = req.body;
  const { tenant_id, company_id } = req.session;

  const r = await pool.query(
    `INSERT INTO accounting_payments
     (id, tenant_id, company_id, type, amount, partner_id, method, reference)
     VALUES (gen_random_uuid(),$1,$2,'receive',$3,$4,$5,$6)
     RETURNING *`,
    [tenant_id, company_id, amount, partner_id, method, reference]
  );
  res.json(r.rows[0]);
});

export default router;
