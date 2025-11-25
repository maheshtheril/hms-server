import { Router } from "express";
import { pool } from "../../db";

const router = Router();

router.get("/", async (req: any, res) => {
  const { tenant_id, company_id } = req.session;

  const r = await pool.query(
    `SELECT * FROM accounting_journals 
     WHERE tenant_id=$1 AND company_id=$2`,
    [tenant_id, company_id]
  );
  res.json({ journals: r.rows });
});

router.post("/", async (req: any, res) => {
  const { name, type } = req.body;
  const { tenant_id, company_id } = req.session;

  const r = await pool.query(
    `INSERT INTO accounting_journals
     (id, tenant_id, company_id, name, type)
     VALUES (gen_random_uuid(),$1,$2,$3,$4)
     RETURNING *`,
    [tenant_id, company_id, name, type]
  );

  res.json(r.rows[0]);
});

export default router;
