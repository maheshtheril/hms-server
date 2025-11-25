import { Router } from "express";
import { pool } from "../../db";

const router = Router();

router.get("/rates", async (req: any, res) => {
  const { tenant_id, company_id } = req.session;

  const r = await pool.query(
    `SELECT * FROM tax_rates WHERE tenant_id=$1 AND company_id=$2`,
    [tenant_id, company_id]
  );

  res.json({ tax_rates: r.rows });
});

router.post("/rates", async (req: any, res) => {
  const { name, rate } = req.body;
  const { tenant_id, company_id } = req.session;

  const r = await pool.query(
    `INSERT INTO tax_rates
     (id, tenant_id, company_id, name, rate)
     VALUES (gen_random_uuid(),$1,$2,$3,$4)
     RETURNING *`,
    [tenant_id, company_id, name, rate]
  );

  res.json(r.rows[0]);
});

export default router;
