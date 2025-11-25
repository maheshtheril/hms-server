import { Router } from "express";
import { pool } from "../../db";

const router = Router();

router.post("/", async (req: any, res) => {
  const { journal_id, memo, date, lines } = req.body;
  const { tenant_id, company_id, user_id } = req.session;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const entry = await client.query(
      `INSERT INTO accounting_journal_entries
       (id, tenant_id, company_id, journal_id, memo, entry_date, created_by)
       VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [tenant_id, company_id, journal_id, memo, date, user_id]
    );

    const entryId = entry.rows[0].id;

    for (const line of lines) {
      await client.query(
        `INSERT INTO accounting_journal_entry_lines
         (id, tenant_id, company_id, entry_id, account_id, debit, credit)
         VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6)`,
        [
          tenant_id,
          company_id,
          entryId,
          line.account_id,
          line.debit || 0,
          line.credit || 0,
        ]
      );
    }

    await client.query("COMMIT");
    res.json({ entry: entry.rows[0] });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("JE ERROR:", err);
    res.status(500).json({ error: "entry_failed" });
  } finally {
    client.release();
  }
});

export default router;
