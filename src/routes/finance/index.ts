// server/src/routes/finance/index.ts
import { Router } from "express";
import { pool } from "../../db";
import requireSession from "../../middleware/requireSession";

const router = Router();

/* =============================
   CHART OF ACCOUNTS
============================= */

router.get("/accounts", requireSession, async (req: any, res) => {
  const { tenant_id, company_id } = req.session;
  const q = `
    SELECT * FROM accounting_chart_of_accounts
    WHERE tenant_id=$1 AND company_id=$2
    ORDER BY code ASC
  `;
  const r = await pool.query(q, [tenant_id, company_id]);
  res.json({ accounts: r.rows });
});

router.post("/accounts", requireSession, async (req: any, res) => {
  const { code, name, type } = req.body;
  const { tenant_id, company_id, user_id } = req.session;
  const q = `
    INSERT INTO accounting_chart_of_accounts
    (id, tenant_id, company_id, code, name, type, created_by)
    VALUES (gen_random_uuid(), $1,$2,$3,$4,$5,$6)
    RETURNING *
  `;
  const r = await pool.query(q, [tenant_id, company_id, code, name, type, user_id]);
  res.json(r.rows[0]);
});

/* =============================
   JOURNALS
============================= */
router.get("/journals", requireSession, async (req, res) => {
  const { tenant_id, company_id } = (req as any).session;
  const r = await pool.query(
    `SELECT * FROM accounting_journals WHERE tenant_id=$1 AND company_id=$2`,
    [tenant_id, company_id]
  );
  res.json({ journals: r.rows });
});

/* =============================
   JOURNAL ENTRIES
============================= */
router.post("/entries", requireSession, async (req: any, res) => {
  const { journal_id, lines, memo, date } = req.body;
  const { tenant_id, company_id, user_id } = req.session;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const entry = await client.query(
      `INSERT INTO accounting_journal_entries
       (id, tenant_id, company_id, journal_id, memo, entry_date, created_by)
       VALUES (gen_random_uuid(), $1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [tenant_id, company_id, journal_id, memo, date, user_id]
    );

    const entryId = entry.rows[0].id;

    for (const row of lines) {
      await client.query(
        `INSERT INTO accounting_journal_entry_lines
         (id, tenant_id, company_id, entry_id, account_id, debit, credit)
         VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6)`,
        [tenant_id, company_id, entryId, row.account_id, row.debit, row.credit]
      );
    }

    await client.query("COMMIT");
    res.json({ entry: entry.rows[0] });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    res.status(500).json({ error: "entry_failed" });
  } finally {
    client.release();
  }
});

/* =============================
   PAYMENTS
============================= */
router.post("/payments/receive", requireSession, async (req: any, res) => {
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

/* =============================
   REPORTS
============================= */
router.get("/reports/balance-sheet", requireSession, async (req: any, res) => {
  const { tenant_id, company_id } = req.session;

  const assets = await pool.query(`
    SELECT account_id, SUM(debit-credit) AS balance
    FROM accounting_journal_entry_lines
    WHERE tenant_id='${tenant_id}' AND company_id='${company_id}'
    GROUP BY account_id
  `);

  res.json({ assets: assets.rows });
});

export default router;
