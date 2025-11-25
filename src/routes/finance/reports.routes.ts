import { Router } from "express";
import { pool } from "../../db";

const router = Router();

router.get("/balance-sheet", async (req: any, res) => {
  const { tenant_id, company_id } = req.session;

  const assets = await pool.query(`
    SELECT account_id, SUM(debit-credit) AS balance
    FROM accounting_journal_entry_lines
    WHERE tenant_id='${tenant_id}'
      AND company_id='${company_id}'
    GROUP BY account_id
  `);

  res.json({ assets: assets.rows });
});

router.get("/profit-loss", async (req: any, res) => {
  const { tenant_id, company_id } = req.session;

  const r = await pool.query(`
    SELECT account_id, SUM(debit-credit) AS balance
    FROM accounting_journal_entry_lines
    WHERE tenant_id='${tenant_id}'
      AND company_id='${company_id}'
    GROUP BY account_id
  `);

  res.json({ pnl: r.rows });
});

export default router;
